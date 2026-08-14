# The two things the messages archive may ask this irssi to do: say something as
# Pippijn, and tell it when somebody says something back.
#
# It listens on TWO pod-local unix sockets, and which socket a request arrives on
# IS the verb. Nothing outside the pod can reach either; the archive gets to them
# through ssh keys on this host pinned to `command="…/irc-send",restrict` and
# `command="…/irc-tail",restrict`, each of whose whole job is to copy one line in
# and one line back.
#
# ⚠ THE SOCKET IS THE VERB, AND THAT IS WHY THERE ARE TWO. The obvious design is
# one socket with an `op` field — and then the tail key, which should only ever
# be able to LISTEN, can send a message by naming the other op. The forced
# command would have to inspect the payload to stop it, which is exactly the
# understanding `irc-send` is careful not to have (see its header). Splitting the
# sockets keeps both scripts dumb: each connects to one path and copies bytes,
# and the separation is structural rather than a check somebody has to keep
# right.
#
# ⚠ WHY A PUSH AT ALL, when a periodic import already collects everything.
# Because the import is a RECONCILER and this is the live path. Sending was
# always synchronous — the app posts, irssi sends, the line comes back, the row
# is written in under a second — while receiving waited for the next import, so
# one conversation had two architectures. Now both directions are the same
# shape: irssi logged a line, the plugin reports where, one row lands on the
# importer's own dedupe key. The import still runs, and its job is to catch what
# this missed. A push that fails is slow, not lost — which is the whole reason
# the fast tier is allowed to be the simpler one.
#
# ⚠ WHY A PLUGIN RATHER THAN `screen -X stuff`, which is how a human would
# automate this and is what the design started as. `stuff` synthesises
# KEYSTROKES: the message body lands on irssi's input line, so every hazard
# becomes a parsing hazard. A leading `/` makes the text a command. `/exec` is a
# shell on this pod. A newline ends the /msg line and starts a fresh command
# line — and screen's `stuff` interprets the two-character sequence `\n` too, so
# a plain backslash in the body is enough without any real newline. Defending
# that means an allow-list of permitted characters: a judgement that has to stay
# right as the input space grows. Here the text is handed to irssi's API as
# DATA, and never reaches a command parser at all. The class is gone rather than
# filtered.
#
# Two more things fall out of it for free:
#
#   * The network is chosen by looking its server tag up directly, so there is
#     no "current window" anywhere in the path. A bare `/msg` goes to whatever
#     the focused window happens to be bound to; that is how medical
#     information once went to schmorp instead of euirc. Here that is not a rule
#     to remember, it is unrepresentable.
#   * Nothing depends on the screen session name, which carries the pod name and
#     therefore changes on every restart.
#
# The echo needs no special handling: the message goes out over irssi's own
# server connection, so irssi logs it exactly as if it had been typed, and the
# hourly importer picks it up unchanged. What this returns is only so the app
# can show the line NOW instead of within the hour — and it returns what the
# log says, not what the app asked for.

use strict;
use warnings;

use Irssi;
use IO::Socket::UNIX;
use JSON::PP;
use Errno qw(EAGAIN EWOULDBLOCK EINTR);

our $VERSION = '1.0';
our %IRSSI = (
    authors     => 'Pippijn van Steenhoven',
    name        => 'archive-send',
    description => 'Send one IRC message on behalf of the messages archive, over a local unix socket.',
    license     => 'MIT',
);

my $SOCK_PATH      = "$ENV{HOME}/.irssi/archive-send.sock";
my $TAIL_SOCK_PATH = "$ENV{HOME}/.irssi/archive-tail.sock";

# How many recent lines are held for a client that is not currently connected.
#
# ⚠ THIS IS THE RECONNECT WINDOW, not a buffer for reliability. The puller
# reconnects in well under a second, so 256 covers any realistic gap; what it
# cannot cover — a puller down for minutes on a busy channel — is precisely what
# the periodic import is for. When the ring has overrun a client's cursor the
# reply says `gap`, so "you have missed things, wait for the reconciler" is
# stated rather than inferred from a silence.
my $RING = 256;

# irssi writes the autolog from its own handler on the same signal this one
# watches, and handler order is not something to depend on. Reading the file a
# moment later sidesteps the question entirely, and 120ms is invisible next to
# the round trip this saves.
#
# ⚠ NOT a guess dressed as a constant: if the line is not there yet the event is
# still delivered, with `logged` false, and the reconciler supplies it. The delay
# buys the common case; it is not load-bearing for correctness.
my $LOG_SETTLE_MS = 120;

# The longest a tail client may be parked. Above this it is told "nothing yet"
# and asks again — which is what proves the connection is still alive.
my $MAX_WAIT_MS = 120_000;

my @events;        # the ring: { seq, tag, target, nick, text, is_own, … }
my $seq     = 0;   # last assigned sequence number
my $oldest  = 1;   # lowest seq still in @events
my %waiters;       # fd => { after, timer }
my $settle_timer;  # pending deferred log lookup, if any

# IRC gives a message about 512 bytes for the whole line including the `:nick!
# user@host PRIVMSG target :` prefix, which is not knowable here with certainty.
# 400 leaves room for any plausible prefix, so a message that is accepted is one
# that arrives whole. Refusing is right rather than splitting: a caller that
# learns its message was too long can decide what to do, where a silent split
# changes what was said.
my $MAX_TEXT = 400;

# A request is one JSON object on one line. 8 KiB is far more than
# $MAX_TEXT can justify and still small enough that a client which never sends
# a newline cannot grow the buffer.
my $MAX_REQUEST = 8192;

# A client that connects and then says nothing must not hold a slot for ever.
my $CLIENT_TIMEOUT_MS = 5000;

my ($listener, $tail_listener);
my ($listen_tag, $tail_listen_tag);
my %clients;    # fd => { sock, tag, timer, buf, kind }

my $json = JSON::PP->new->utf8->canonical;

# ---------------------------------------------------------------- validation

# Server tags are irssi's own names for networks — its config writes them, so
# they are short and boring by construction. Anything outside this is a caller
# bug, not a network anybody has.
sub valid_network {
    my ($s) = @_;
    return defined $s && !ref $s && $s =~ /\A[A-Za-z0-9_.-]{1,64}\z/;
}

# A channel (`#`/`&`) or a nick. The exclusions are IRC's own: NUL, CR, LF and
# space terminate or split a protocol line, and `,` separates targets in
# PRIVMSG — so a target containing one would address more people than the
# allow-list was checked against.
sub valid_target {
    my ($s) = @_;
    return 0 unless defined $s && !ref $s && length $s >= 1 && length $s <= 64;
    return 0 if $s =~ /[\x00-\x20,:\x7F]/;
    return 1;
}

# ⚠ CONTROL CHARACTERS ARE REFUSED RATHER THAN STRIPPED. CR and LF end an IRC
# protocol line, so a body containing one is a second command to the server —
# the same injection the plugin exists to prevent, one layer further down.
# Stripping would send a message the caller did not write; refusing tells it so.
sub validate_text {
    my ($s) = @_;
    return 'text missing'   unless defined $s;
    # ⚠ A ref STRINGIFIES before the pattern below ever sees it, so a JSON
    # object arrives as `HASH(0x55f…)`: it passes every check and is sent. The
    # type has to be rejected, not the shape of what it prints as.
    return 'text is not a string' if ref $s;
    return 'text empty'     unless length $s;
    return 'text too long'  if length $s > $MAX_TEXT;
    return 'text contains a control character' if $s =~ /[\x00-\x1F\x7F]/;
    return undef;
}

# --------------------------------------------------------------- who may be sent to
#
# ⚠ **AN OPEN TAB IS THE PERMISSION.** There is no allow-list file: what this may
# say something to is exactly what irssi has a window item for — a channel that
# is joined, or a query that is open.
#
# This replaced a hand-maintained `network target` file, and it is better on
# every axis that matters. It cannot go stale, because it IS the live state
# rather than a description of it. It is maintained by ordinary use: closing a
# tab revokes, opening a query grants, and neither is a thing to remember. And it
# is the same rule as the one the keyboard already obeys — this can say something
# to precisely the conversations Pippijn could have typed into.
#
# The lookup is per-server, so the network is not a second thing to check: a
# window item found on this server's object is on this network by construction.
#
# ⚠ IT IS NOT PURELY CURATED, and that is worth knowing rather than assuming
# away. `autocreate_query_level` is `MSGS DCCMSGS`, so a private message from
# anybody opens a query and widens this set by somebody else's action. Two things
# bound it: Pippijn sees the tab appear, and the app addresses conversations by
# their id in the ARCHIVE, so a query created a minute ago is not addressable
# until an import has seen it. Open tab and archived conversation, not either.
sub may_send_to {
    my ($server, $target) = @_;
    # Comparison is irssi's own, which is IRC's: case-insensitive, and aware that
    # a channel and a nick of the same name are different things.
    return defined $server->window_item_find($target);
}

# ------------------------------------------------------------------------ log
#
# Where irssi will have written the echo. Derived from irssi's own
# `autolog_path` rather than assumed, so the two cannot drift apart.
sub log_path_for {
    my ($tag, $target, @tm) = @_;
    my $path = Irssi::settings_get_str('autolog_path');
    $path =~ s/\A~/$ENV{HOME}/;
    $path =~ s/\$tag/$tag/g;
    $path =~ s/\$0/lc $target/ge;
    # Only the fields irssi's default path uses. strftime would accept the
    # string wholesale, but it is a template from settings and expanding
    # everything in it is a wider promise than this needs to make.
    my ($mday, $mon, $year) = @tm[3, 4, 5];
    $path =~ s/%Y/sprintf '%04d', $year + 1900/ge;
    $path =~ s/%m/sprintf '%02d', $mon + 1/ge;
    $path =~ s/%d/sprintf '%02d', $mday/ge;
    return $path;
}

# Find the line irssi just logged, and say where it is.
#
# ⚠ SCANNING FROM THE END RATHER THAN TAKING THE LAST LINE. In a channel
# somebody else can speak between the send and this read, so "the last line" is
# not reliably ours. Matching on the text we sent is.
#
# `line_no` counts physical lines from 1 — every line, including irssi's
# `--- Log opened` markers — because that is how the importer numbers them and
# the two halves of the dedupe key must agree. If they disagree the hourly
# import writes a second copy of the message and it appears twice.
sub find_logged_line {
    my ($path, $text) = @_;
    open my $fh, '<:encoding(UTF-8)', $path or return undef;
    my ($found_no, $found_line);
    my $n = 0;
    while (my $line = <$fh>) {
        $n++;
        chomp $line;
        # `index` rather than a regex: the text is arbitrary and would otherwise
        # be a pattern. Comparing on a substring, not equality, because irssi
        # prefixes its timestamp and formats the nick around what we sent.
        next if index($line, $text) < 0;
        ($found_no, $found_line) = ($n, $line);
    }
    close $fh;
    return defined $found_no ? { line_no => $found_no, line => $found_line } : undef;
}

# ----------------------------------------------------------------- the request

sub handle_request {
    my ($raw) = @_;

    my $req = eval { $json->decode($raw) };
    return { ok => JSON::PP::false, error => 'request is not JSON' } if $@ || ref $req ne 'HASH';

    my ($network, $target, $text) = @{$req}{qw(network target text)};

    return err('bad network') unless valid_network($network);
    return err('bad target')  unless valid_target($target);
    if (my $why = validate_text($text)) {
        return err($why);
    }

    my $server = Irssi::server_find_tag($network);
    # One refusal for "no such network" and for "no tab open there", so the
    # answer does not tell a caller which networks exist.
    return err('refused: no conversation open with that target') unless $server;
    return err('refused: no conversation open with that target')
        unless may_send_to($server, $target);
    return err('network not connected') unless $server->{connected};

    send_message($server, $target, $text);

    # irssi writes its timestamp with minute precision, so the echo is looked
    # for against the local clock's minute. Taking the time before the send
    # would risk naming the previous minute for a send that straddles one.
    my @tm  = localtime(time);
    my $path = log_path_for($network, $target, @tm);
    my $hit  = find_logged_line($path, $text);

    # ⚠ NOT AN ERROR: the message has been sent by this point and saying
    # otherwise would be a lie. What is missing is only the app's ability to
    # show it immediately; the hourly import will still find it.
    return {
        ok      => JSON::PP::true,
        network => $network,
        target  => $target,
        text    => $text,
        # ⚠ REPORTED BY IRSSI, NOT ASSUMED BY THE CALLER, because both are half
        # of the archive's dedupe key and a caller's guess that drifts would put
        # the message in twice.
        #
        # `tag` is what irssi writes the log directory as, which is what the
        # importer stores as `source_tag` — the RAW tag, before any --map that
        # folds a second connection's tag into one network. `nick` is who the
        # line will be attributed to, which is the server's current nick and not
        # necessarily the one in the config: a nick collision on connect leaves
        # you on the alternate.
        tag    => $server->{tag},
        nick   => $server->{nick},
        logged => $hit ? JSON::PP::true : JSON::PP::false,
        $hit
        ? (
            file_date => sprintf('%04d-%02d-%02d', $tm[5] + 1900, $tm[4] + 1, $tm[3]),
            line_no   => $hit->{line_no},
            line      => $hit->{line},
          )
        : (),
    };
}

sub err {
    my ($why) = @_;
    return { ok => JSON::PP::false, error => $why };
}

# ------------------------------------------------------------------ the tail
#
# Every line irssi logs as conversation, offered to whoever is waiting.
#
# ⚠ WHAT IS RECORDED IS WHERE THE LINE IS, NOT WHAT THE SIGNAL SAID. The archive
# keys a message on `(conversation, source_tag, file_date, line_no)`, so an event
# is only useful if it carries that key — and the only authority for `line_no` is
# the log file irssi just wrote. The signal supplies the text to find it BY. This
# is the same trick the send path uses for its echo, and reusing it is the point:
# one way of turning "irssi logged something" into the archive's key, so the two
# directions cannot disagree about where a line is.
sub record_event {
    my ($server, $text, $nick, $target, $is_own) = @_;

    # ⚠ DEFENSIVE, BECAUSE A SIGNAL SIGNATURE IS AN ASSUMPTION. These handlers
    # unpack positional arguments from irssi's own event; if a signature is not
    # what this believes, the wrong string lands in the wrong variable. Validated
    # here, a mistake becomes a line that is not pushed — which the reconciler
    # collects within the hour — instead of a row filed under a nonsense target.
    return unless $server && !ref $text && defined $text && length $text;
    return unless valid_target($target);
    return unless !defined $nick || valid_target($nick);

    $seq++;
    push @events, {
        seq     => $seq,
        tag     => $server->{tag},
        target  => $target,
        nick    => defined $nick ? $nick : $server->{nick},
        text    => $text,
        is_own  => $is_own ? JSON::PP::true : JSON::PP::false,
        settled => 0,
    };
    while (@events > $RING) {
        shift @events;
        $oldest++;
    }

    # One deferred pass settles every event that has arrived since the last one,
    # so a busy channel costs one timer rather than one per line.
    $settle_timer = Irssi::timeout_add_once($LOG_SETTLE_MS, \&settle_and_wake, undef)
        unless defined $settle_timer;
}

# Attach each new event's place in the log, then answer anybody waiting.
sub settle_and_wake {
    $settle_timer = undef;
    my @tm = localtime(time);
    my $file_date = sprintf '%04d-%02d-%02d', $tm[5] + 1900, $tm[4] + 1, $tm[3];

    for my $ev (@events) {
        next if $ev->{settled};
        $ev->{settled} = 1;
        my $hit = find_logged_line(log_path_for($ev->{tag}, $ev->{target}, @tm), $ev->{text});
        # ⚠ Not an error, and not a reason to withhold the event: the line exists
        # and the reconciler will place it. Saying `logged: false` lets the
        # puller show it without inventing a key for it.
        $ev->{logged} = $hit ? JSON::PP::true : JSON::PP::false;
        if ($hit) {
            $ev->{file_date} = $file_date;
            $ev->{line_no}   = $hit->{line_no};
            $ev->{line}      = $hit->{line};
        }
    }
    wake_waiters();
}

# The wire form. `settled` is bookkeeping and does not leave the plugin.
sub event_for_wire {
    my ($ev) = @_;
    return { map { $_ => $ev->{$_} } grep { $_ ne 'settled' } keys %$ev };
}

sub events_after {
    my ($after) = @_;
    return grep { $_->{seq} > $after && $_->{settled} } @events;
}

sub reply_to_waiter {
    my ($fd, $after) = @_;
    my @out = events_after($after);
    return 0 unless @out;
    send_reply($fd, {
        ok     => JSON::PP::true,
        seq    => $seq,
        events => [ map { event_for_wire($_) } @out ],
        # ⚠ The client's cursor has fallen off the back of the ring, so there are
        # lines it will never be handed. Stated, not implied by a short list:
        # this is the one case where the fast path is knowingly incomplete and
        # the reconciler is the only thing that will close it.
        ($after > 0 && $after < $oldest - 1) ? (gap => JSON::PP::true) : (),
    });
    return 1;
}

sub wake_waiters {
    for my $fd (keys %waiters) {
        my $w = $waiters{$fd} or next;
        next unless events_after($w->{after});
        Irssi::timeout_remove($w->{timer}) if defined $w->{timer};
        delete $waiters{$fd};
        reply_to_waiter($fd, $w->{after});
    }
}

# A tail request parks until there is something to say, or until its own
# deadline. Answering an empty list on timeout is deliberate: it is what tells
# the puller the connection is still good, so a wedged plugin looks different
# from a quiet channel.
sub handle_wait {
    my ($fd, $raw) = @_;

    my $req = eval { $json->decode($raw) };
    return send_reply($fd, err('request is not JSON')) if $@ || ref $req ne 'HASH';

    my $after = $req->{after};
    $after = 0 unless defined $after && !ref $after && $after =~ /\A[0-9]{1,19}\z/;
    # A cursor ahead of ours means the plugin restarted and the sequence began
    # again. Starting from here is right: the lines it names are already in the
    # archive or will be, and the alternative is replaying the whole ring.
    $after = $seq if $after > $seq;

    my $timeout = $req->{timeout_ms};
    $timeout = $MAX_WAIT_MS
        unless defined $timeout && !ref $timeout && $timeout =~ /\A[0-9]{1,7}\z/;
    $timeout = $MAX_WAIT_MS if $timeout > $MAX_WAIT_MS;

    return if reply_to_waiter($fd, $after);

    $waiters{$fd} = {
        after => $after,
        timer => Irssi::timeout_add_once($timeout, sub {
            my $w = delete $waiters{$fd} or return;
            send_reply($fd, { ok => JSON::PP::true, seq => $seq, events => [] });
        }, undef),
    };
}

# ⚠ TWO STEPS, AND BOTH ARE NEEDED — this is the part that is easy to get
# half-right. `send_message` puts the PRIVMSG on the wire and does nothing else:
# it emits no signal, so irssi neither shows the line in the window nor writes
# it to the autolog. Sending with it alone would deliver the message to the
# other person and leave no trace on this side — the app's echo would be empty
# and, worse, the archive would never learn the message existed. The signal is
# what every display and logging handler is listening for, so emitting it is
# what makes the line appear exactly as a typed one does.
#
# MEASURED RATHER THAN READ OFF THE API DOCS, because getting it backwards the
# other way would log every message twice. Emitting the signal alone, with
# nothing put on the wire, logged exactly ONE line; `send_message` plus the
# signal logged TWO. Had `send_message` emitted on its own account there would
# have been three — its own, ours, and the copy the server sends back when the
# target is yourself. So its contribution is only that round trip, which a real
# target does not produce: one message to somebody else logs one line.
#
# The alternative is `$server->command("msg ...")`, which does both in one call
# because that is literally what typing does. It is not used because it hands
# the text back to a command parser, which is the thing this whole script exists
# to avoid — a narrower parser than the input line, but still a parser, and
# still one that reads `$` and a leading `-` as meaning something.
sub send_message {
    my ($server, $target, $text) = @_;

    my $is_channel = $target =~ /\A[#&]/;

    # 0 is a channel and 1 is a nick, from irssi's own SEND_TARGET_ constants.
    $server->send_message($target, $text, $is_channel ? 0 : 1);

    # `own_private` carries the target twice: what was typed and what it
    # resolved to. They are the same here — nothing in this path rewrites it.
    $is_channel
        ? Irssi::signal_emit('message own_public',  $server, $text, $target)
        : Irssi::signal_emit('message own_private', $server, $text, $target, $target);
}

# ------------------------------------------------------------------- plumbing

sub drop {
    my ($fd, $why) = @_;
    my $w = delete $waiters{$fd};
    Irssi::timeout_remove($w->{timer}) if $w && defined $w->{timer};
    my $st = delete $clients{$fd} or return;
    Irssi::input_remove($st->{tag})    if defined $st->{tag};
    Irssi::timeout_remove($st->{timer}) if defined $st->{timer};
    close $st->{sock};
    Irssi::print("archive-send: dropped a client ($why)") if defined $why;
}

# One reply, then the connection is over. Best effort: a client that has gone
# away cannot be told anything, and whatever the request did has been done.
sub send_reply {
    my ($fd, $reply) = @_;
    my $st = $clients{$fd} or return;
    eval {
        local $SIG{PIPE} = 'IGNORE';
        syswrite($st->{sock}, $json->encode($reply) . "\n");
    };
    drop($fd);
}

sub on_client_readable {
    my ($fd) = @_;
    my $st = $clients{$fd} or return;

    my $chunk = '';
    my $n = sysread($st->{sock}, $chunk, 4096);
    if (!defined $n) {
        return if $! == EAGAIN || $! == EWOULDBLOCK || $! == EINTR;
        return drop($fd, "read failed: $!");
    }
    return drop($fd, 'client closed before sending a request') if $n == 0;

    $st->{buf} .= $chunk;
    return drop($fd, 'request too large') if length $st->{buf} > $MAX_REQUEST;
    return unless $st->{buf} =~ /\n/;

    my ($line) = $st->{buf} =~ /\A([^\n]*)\n/;

    # The socket decided the verb at accept time. A tail client cannot reach the
    # send path by asking for it, because nothing here reads what it asked for.
    if ($st->{kind} eq 'tail') {
        # The parking timer is the wait's own; the connect timer has done its job.
        Irssi::timeout_remove($st->{timer}) if defined $st->{timer};
        $st->{timer} = undef;
        return handle_wait($fd, $line);
    }

    my $reply = eval { handle_request($line) } || err('internal error');
    send_reply($fd, $reply);
}

sub accept_client {
    my ($sock, $kind) = @_;
    $sock->blocking(0);
    my $fd = fileno($sock);
    $clients{$fd} = {
        sock  => $sock,
        buf   => '',
        kind  => $kind,
        tag   => Irssi::input_add($fd, Irssi::INPUT_READ, sub { on_client_readable($fd) }, undef),
        timer => Irssi::timeout_add_once($CLIENT_TIMEOUT_MS, sub { drop($fd, 'timed out') }, undef),
    };
}

sub on_listener_readable {
    my $sock = $listener->accept() or return;
    accept_client($sock, 'send');
}

sub on_tail_listener_readable {
    my $sock = $tail_listener->accept() or return;
    accept_client($sock, 'tail');
}

sub listen_on {
    my ($path) = @_;

    # A stale socket file survives an unclean exit and would make bind fail, so
    # the script would refuse to load after any crash. Removing it is safe: the
    # only writer is this script, running as this user, inside this pod.
    unlink $path if -S $path;

    # 0600 before anything can connect: created with a restrictive umask rather
    # than chmod'ed afterwards, so there is no window in which it is open.
    my $umask = umask 0177;
    my $sock = IO::Socket::UNIX->new(
        Type   => SOCK_STREAM(),
        Local  => $path,
        Listen => 5,
    );
    umask $umask;

    Irssi::print("archive-send: could not listen on $path: $!") unless $sock;
    $sock->blocking(0) if $sock;
    return $sock;
}

sub start {
    $listener = listen_on($SOCK_PATH) or return;
    $listen_tag = Irssi::input_add(fileno($listener), Irssi::INPUT_READ, \&on_listener_readable, undef);

    $tail_listener = listen_on($TAIL_SOCK_PATH);
    if ($tail_listener) {
        $tail_listen_tag = Irssi::input_add(
            fileno($tail_listener), Irssi::INPUT_READ, \&on_tail_listener_readable, undef);
    }

    # ⚠ `signal_add_last`, so irssi's own logging handler has run by the time
    # this one does. It is not enough on its own — see `$LOG_SETTLE_MS`, which is
    # what actually makes the ordering irrelevant — but asking to be last costs
    # nothing and makes the common case immediate.
    #
    # The four signatures below are irssi's, and `record_event` validates what it
    # unpacks rather than trusting them: a signature that is not what this
    # believes turns into a line the reconciler collects, not a bad row.
    Irssi::signal_add_last('message public' => sub {
        my ($server, $msg, $nick, $address, $target) = @_;
        record_event($server, $msg, $nick, $target, 0);
    });
    Irssi::signal_add_last('message private' => sub {
        my ($server, $msg, $nick, $address) = @_;
        # A private message's conversation is the sender, which is where irssi
        # logs it — `$0` in `autolog_path` is the query's name.
        record_event($server, $msg, $nick, $nick, 0);
    });
    # ⚠ Pippijn typing in irssi directly counts. Before this, his own messages
    # reached the archive only via the import, so the app showed his side of a
    # conversation minutes behind the other person's.
    Irssi::signal_add_last('message own_public' => sub {
        my ($server, $msg, $target) = @_;
        record_event($server, $msg, undef, $target, 1);
    });
    Irssi::signal_add_last('message own_private' => sub {
        my ($server, $msg, $target, $orig_target) = @_;
        record_event($server, $msg, undef, $target, 1);
    });

    Irssi::print("archive-send: listening on $SOCK_PATH"
        . ($tail_listener ? " and $TAIL_SOCK_PATH" : ''));
}

sub stop {
    drop($_, undef) for keys %clients;
    Irssi::timeout_remove($settle_timer) if defined $settle_timer;
    Irssi::input_remove($listen_tag)      if defined $listen_tag;
    Irssi::input_remove($tail_listen_tag) if defined $tail_listen_tag;
    close $listener      if $listener;
    close $tail_listener if $tail_listener;
    unlink $SOCK_PATH      if -S $SOCK_PATH;
    unlink $TAIL_SOCK_PATH if -S $TAIL_SOCK_PATH;
}

# Reloading the script must not leave the old listener holding the socket.
Irssi::signal_add_first('script unloaded' => sub {
    my ($script) = @_;
    stop() if $script->{name} eq 'archive_send';
});

start();

# The one thing the messages archive may ask this irssi to do: say something,
# as Pippijn, to somebody already on a list.
#
# It listens on a pod-local unix socket. Nothing outside the pod can reach that
# socket; the archive gets to it through an ssh key on this host pinned to
# `command="/home/irssi/bin/irc-send",restrict`, whose whole job is to copy one
# line in and one line back. Two layers, one job each.
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

my $SOCK_PATH  = "$ENV{HOME}/.irssi/archive-send.sock";
my $ALLOW_PATH = "$ENV{HOME}/.irssi/archive-send.allow";

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

my $listener;
my $listen_tag;
my %clients;    # fd => { sock, tag, timer, buf }

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

# ------------------------------------------------------------------ allow-list
#
# Read fresh on every request, deliberately: widening it is then a one-line edit
# to a file on the volume, with no reload and no restart. It is a file rather
# than a constant here because who Pippijn talks to is not something this public
# repository should record.
#
# Format: `network target`, one per line. Blank lines are ignored, and a line
# whose first non-blank character is `#` is a comment.
#
# ⚠ A COMMENT IS ONLY A WHOLE LINE, and that is not a stylistic choice. Stripping
# `#` to end-of-line anywhere — the obvious way to write this — deletes the `#`
# and everything after it from `testnet #room`, leaving `testnet`, which parses
# as nothing and silently refuses every channel there is. IRC channel names
# begin with the comment character.
sub allowed {
    my ($network, $target) = @_;
    open my $fh, '<', $ALLOW_PATH or return 0;
    my $ok = 0;
    while (my $line = <$fh>) {
        next if $line =~ /\A\s*(?:#|\z)/;
        my ($n, $t) = $line =~ /\A\s*(\S+)\s+(\S+)\s*\z/ or next;
        # IRC compares nicks and channels case-insensitively, so this must too,
        # or an allow-list entry could be bypassed by changing one letter's case.
        next unless lc $n eq lc $network;
        next unless lc $t eq lc $target;
        $ok = 1;
        last;
    }
    close $fh;
    return $ok;
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

    # The allow-list is checked before anything is looked up, so a refusal
    # cannot be told apart from a network that does not exist by timing or by
    # the error text: both are just "refused".
    return err('refused: not on the allow-list') unless allowed($network, $target);

    my $server = Irssi::server_find_tag($network);
    return err('refused: not on the allow-list') unless $server;
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
        ok       => JSON::PP::true,
        network  => $network,
        target   => $target,
        text     => $text,
        logged   => $hit ? JSON::PP::true : JSON::PP::false,
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
    my $st = delete $clients{$fd} or return;
    Irssi::input_remove($st->{tag})    if defined $st->{tag};
    Irssi::timeout_remove($st->{timer}) if defined $st->{timer};
    close $st->{sock};
    Irssi::print("archive-send: dropped a client ($why)") if defined $why;
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
    my $reply = eval { handle_request($line) } || err('internal error');
    # Best effort: a client that has gone away cannot be told anything, and the
    # message has already been sent either way.
    eval {
        local $SIG{PIPE} = 'IGNORE';
        syswrite($st->{sock}, $json->encode($reply) . "\n");
    };
    drop($fd);
}

sub on_listener_readable {
    my $sock = $listener->accept() or return;
    $sock->blocking(0);
    my $fd = fileno($sock);
    $clients{$fd} = {
        sock  => $sock,
        buf   => '',
        tag   => Irssi::input_add($fd, Irssi::INPUT_READ, sub { on_client_readable($fd) }, undef),
        timer => Irssi::timeout_add_once($CLIENT_TIMEOUT_MS, sub { drop($fd, 'timed out') }, undef),
    };
}

sub start {
    # A stale socket file survives an unclean exit and would make bind fail, so
    # the script would refuse to load after any crash. Removing it is safe: the
    # only writer is this script, running as this user, inside this pod.
    unlink $SOCK_PATH if -S $SOCK_PATH;

    # 0600 before anything can connect: created with a restrictive umask rather
    # than chmod'ed afterwards, so there is no window in which it is open.
    my $umask = umask 0177;
    $listener = IO::Socket::UNIX->new(
        Type   => SOCK_STREAM(),
        Local  => $SOCK_PATH,
        Listen => 5,
    );
    umask $umask;

    if (!$listener) {
        Irssi::print("archive-send: could not listen on $SOCK_PATH: $!");
        return;
    }
    $listener->blocking(0);
    $listen_tag = Irssi::input_add(fileno($listener), Irssi::INPUT_READ, \&on_listener_readable, undef);
    Irssi::print("archive-send: listening on $SOCK_PATH");
}

sub stop {
    drop($_, undef) for keys %clients;
    Irssi::input_remove($listen_tag) if defined $listen_tag;
    close $listener if $listener;
    unlink $SOCK_PATH if -S $SOCK_PATH;
}

# Reloading the script must not leave the old listener holding the socket.
Irssi::signal_add_first('script unloaded' => sub {
    my ($script) = @_;
    stop() if $script->{name} eq 'archive_send';
});

start();

#!/usr/bin/env perl
#
# The tail half of archive-send.pl: what the archive learns, and how fast.
#
# ⚠ THE FIRST TEST BELOW IS THE WHOLE SECURITY ARGUMENT FOR TWO SOCKETS. The
# tail key exists so the archive can LISTEN. If a request arriving on the tail
# socket could name the send op, that key would be able to speak as Pippijn —
# and the forced command could only stop it by parsing the payload, which is the
# understanding `irc-send` is deliberately built without. Here the verb is
# decided at accept time, so it is not a check that can be got wrong.
#
# Run: perl test/archive-tail.t

use strict;
use warnings;

use FindBin;
use lib "$FindBin::Bin/lib";

use Irssi;
use IO::Socket::UNIX;
use IO::Select;
use JSON::PP;
use File::Temp qw(tempdir);
use Time::HiRes ();
use Test::More;

my $home = tempdir(CLEANUP => 1);
$ENV{HOME} = $home;
mkdir "$home/.irssi";

my $NET  = 'testnet';
my $NICK = 'friend';
my $CHAN = '#room';

my $server = Irssi::Test::Server->new(tag => $NET);
$server->open_tab($NICK);
$server->open_tab($CHAN);
$Irssi::SERVERS{$NET} = $server;

do "$FindBin::Bin/../home/pippijn/.irssi/scripts/autorun/archive-send.pl"
    or die "could not load the script: ${\($@ || $!)}";

my $tail_path = "$home/.irssi/archive-tail.sock";
my $send_path = "$home/.irssi/archive-send.sock";
my $json = JSON::PP->new->utf8->canonical;

ok(-S $tail_path, 'the tail socket exists');
is((stat $tail_path)[2] & 07777, 0600, 'the tail socket is not readable by anyone else');

# Write a log file where the script will look for one, so a recorded event can
# find its line number the way it does in production.
sub write_log {
    my ($tag, $target, @lines) = @_;
    my @tm = localtime(time);
    my $dir = sprintf '%s/irclogs/%s/%04d/%02d/%02d', $home, $tag, $tm[5] + 1900, $tm[4] + 1, $tm[3];
    system('mkdir', '-p', $dir) == 0 or die "mkdir $dir";
    my $file = sprintf '%s/%s.log', $dir, lc $target;
    open my $fh, '>', $file or die "open $file: $!";
    print {$fh} "$_\n" for @lines;
    close $fh;
    return $file;
}

# Park a tail request and hand back the still-open socket.
sub park {
    my (%opt) = @_;
    my $client = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $tail_path)
        or die "connect: $!";
    print {$client} $json->encode({
        after      => $opt{after}      // 0,
        timeout_ms => $opt{timeout_ms} // 60_000,
    }), "\n";
    $client->flush;
    Irssi::run(0.1);    # accept + read + park
    return $client;
}

# Let the deferred log lookup come due, then run it.
sub settle {
    Time::HiRes::sleep(0.2);
    Irssi::fire_timeouts();
}

# ⚠ BOUNDED, because the thing under test is a socket that deliberately does not
# answer yet. A bare `<$client>` on a parked request blocks for as long as the
# plugin decided to park it, and a test that forgets a short `timeout_ms` then
# hangs for two minutes with no clue why — which is how this file was first
# written.
sub reply_from {
    my ($client, $secs) = @_;
    my $sel = IO::Select->new($client);
    my $line;
    $line = <$client> if $sel->can_read($secs // 3);
    close $client;
    return defined $line ? $json->decode($line) : undef;
}

# ---------------------------------------------------------------- the verb

{
    # A perfectly-formed send request, on the wrong socket.
    my $client = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $tail_path)
        or die "connect: $!";
    print {$client} $json->encode({
        op => 'send', network => $NET, target => $NICK, text => 'speak as him',
        # A short deadline only so the test does not sit through the full park;
        # the send fields above are what is under test.
        timeout_ms => 150,
    }), "\n";
    $client->flush;
    Irssi::run(0.1);
    Time::HiRes::sleep(0.25);
    Irssi::fire_timeouts();
    my $reply = reply_from($client);

    is(scalar @{ $server->{sent} }, 0,
        'a send request on the TAIL socket sends NOTHING — the socket is the verb');
    ok($reply && $reply->{ok}, 'it is read as a tail request, not refused as a bad send');
    is_deeply($reply->{events}, [], 'and there is nothing to report yet');
}

# ------------------------------------------------------- somebody speaks

{
    write_log($NET, $CHAN, '--- Log opened Thu Aug 14 00:00:00 2026', '10:00 < friend> hello there');
    my $client = park();
    Irssi::deliver('message public', $server, 'hello there', $NICK, 'friend@host', $CHAN);
    settle();
    my $reply = reply_from($client);

    ok($reply->{ok}, 'a parked tail request is answered when a line arrives');
    is(scalar @{ $reply->{events} }, 1, 'one event');
    my $ev = $reply->{events}[0];
    is($ev->{tag},    $NET,  'the tag irssi logs under');
    is($ev->{target}, $CHAN, 'the conversation');
    is($ev->{nick},   $NICK, 'who said it');
    is($ev->{text},   'hello there', 'what was said');
    ok(!$ev->{is_own}, 'not ours');
    # ⚠ The two halves of the archive's dedupe key, and the reason the event is
    # worth having at all: without them the puller could only say "something
    # changed" and would have to fetch the file to find out where.
    ok($ev->{logged}, 'the line was found in the log');
    is($ev->{line_no}, 2, 'counted from 1 including the Log opened marker');
    like($ev->{file_date}, qr/\A\d{4}-\d{2}-\d{2}\z/, 'and the date the importer will use');
}

# --------------------------------------------------- Pippijn types in irssi

{
    write_log($NET, $CHAN, '--- Log opened Thu Aug 14 00:00:00 2026',
        '10:00 < friend> hello there', '10:01 < me> typed straight into irssi');
    my $client = park(after => 1);
    Irssi::deliver('message own_public', $server, 'typed straight into irssi', $CHAN);
    settle();
    my $reply = reply_from($client);

    is(scalar @{ $reply->{events} }, 1, 'his own line is pushed too');
    my $ev = $reply->{events}[0];
    ok($ev->{is_own}, 'marked as his');
    is($ev->{nick}, 'me', "attributed to the server's current nick");
    is($ev->{line_no}, 3, 'and placed in the log');
}

# ------------------------------------------------------------ the cursor

{
    # Nothing new since the client's cursor: it parks rather than being told
    # about lines it already has.
    my $client = park(after => 2, timeout_ms => 150);
    Time::HiRes::sleep(0.25);
    Irssi::fire_timeouts();
    my $reply = reply_from($client);
    ok($reply->{ok}, 'a wait with nothing new answers on its own deadline');
    is_deeply($reply->{events}, [], 'with an empty list');
    # ⚠ An empty answer is the point: it is what tells the puller the plugin is
    # alive. Holding the connection open for ever would make a wedged irssi look
    # exactly like a quiet afternoon.
    is($reply->{seq}, 2, 'and reports where the sequence stands');
}

{
    # A cursor ahead of ours — the plugin restarted and began counting again.
    my $client = park(after => 9999, timeout_ms => 150);
    Time::HiRes::sleep(0.25);
    Irssi::fire_timeouts();
    my $reply = reply_from($client);
    is($reply->{seq}, 2, 'a cursor from a previous life is reset, not replayed');
    is_deeply($reply->{events}, [], 'and nothing is re-sent');
}

done_testing();

#!/usr/bin/env perl
#
# What archive-send.pl refuses, and what it lets through.
#
# The refusals are the point. This script is the only thing standing between a
# web request and Pippijn's IRC identity, so each test here names an attack the
# design is supposed to have made impossible rather than merely unlikely, and
# checks that NOTHING WAS SENT — an error reply with the message already on the
# wire would be the worst of both.
#
# Run: perl test/archive-send.t

use strict;
use warnings;

use FindBin;
use lib "$FindBin::Bin/lib";

use Irssi;
use IO::Socket::UNIX;
use JSON::PP;
use File::Temp qw(tempdir);
use Test::More;

my $home = tempdir(CLEANUP => 1);
$ENV{HOME} = $home;
mkdir "$home/.irssi";

my $NET    = 'testnet';
my $NICK   = 'friend';
my $CHAN   = '#room';

open my $allow, '>', "$home/.irssi/archive-send.allow" or die $!;
print $allow "# who the archive may talk to\n";
print $allow "$NET $NICK\n";
print $allow "$NET $CHAN\n";
close $allow;

my $server = Irssi::Test::Server->new(tag => $NET);
$Irssi::SERVERS{$NET} = $server;

do "$FindBin::Bin/../home/pippijn/.irssi/scripts/autorun/archive-send.pl"
    or die "could not load the script: ${\($@ || $!)}";

my $sock_path = "$home/.irssi/archive-send.sock";
ok(-S $sock_path, 'the script is listening on its socket');

my @mode = stat $sock_path;
is($mode[2] & 07777, 0600, 'the socket is not readable by anyone else');

my $json = JSON::PP->new->utf8->canonical;

# Send one request and return the decoded reply.
sub ask {
    my ($payload) = @_;
    my $client = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $sock_path)
        or die "connect: $!";
    print $client (ref $payload ? $json->encode($payload) : $payload), "\n";
    Irssi::run();
    my $reply = <$client>;
    close $client;
    return defined $reply ? $json->decode($reply) : undef;
}

sub sent_count { scalar @{ $server->{sent} } }

# ------------------------------------------------------------- the happy path

{
    my $before = sent_count();
    my $r = ask({ network => $NET, target => $NICK, text => 'hello there' });
    ok($r->{ok}, 'an allow-listed nick is accepted');
    is(sent_count(), $before + 1, 'exactly one message was sent');
    my $last = $server->{sent}[-1];
    is($last->{target}, $NICK, 'sent to the nick asked for');
    is($last->{text}, 'hello there', 'sent the text asked for, unaltered');
    is($last->{type}, 1, 'a nick is addressed as a nick, not as a channel');
    is($Irssi::SIGNALS[-1][0], 'message own_private',
        'the own-message signal is emitted, which is what makes irssi log it');
}

{
    my $before = sent_count();
    my $r = ask({ network => $NET, target => $CHAN, text => 'hello room' });
    ok($r->{ok}, 'an allow-listed channel is accepted');
    is($server->{sent}[-1]{type}, 0, 'a channel is addressed as a channel');
    is($Irssi::SIGNALS[-1][0], 'message own_public', 'the public own-message signal');
    is(sent_count(), $before + 1, 'exactly one message was sent');
}

# ------------------------------------------------- what stuffing would have run
#
# Each of these is a payload that `screen -X stuff` would have handed to irssi's
# input line as a COMMAND. Here they must arrive as ordinary text, unchanged.

for my $text (
    '/exec rm -rf /',
    '/quit',
    'look: a backslash-n \n and another \\n',
    'trailing backslash \\',
    '$expandme and ${this}',
    '-not-an-option',
) {
    my $before = sent_count();
    my $r = ask({ network => $NET, target => $NICK, text => $text });
    ok($r->{ok}, "accepted as text: $text");
    is(sent_count(), $before + 1, "one message sent for: $text");
    is($server->{sent}[-1]{text}, $text, "delivered verbatim, not interpreted: $text");
}

# ----------------------------------------------------------------- the refusals

my @refused = (
    ['a real newline',        { network => $NET, target => $NICK, text => "one\ntwo" }],
    ['a carriage return',     { network => $NET, target => $NICK, text => "one\rtwo" }],
    ['a NUL',                 { network => $NET, target => $NICK, text => "one\0two" }],
    ['an escape',             { network => $NET, target => $NICK, text => "one\x1btwo" }],
    ['empty text',            { network => $NET, target => $NICK, text => '' }],
    ['missing text',          { network => $NET, target => $NICK }],
    ['overlong text',         { network => $NET, target => $NICK, text => 'x' x 401 }],
    ['a nick not on the list', { network => $NET, target => 'stranger', text => 'hi' }],
    ['a channel not on the list', { network => $NET, target => '#elsewhere', text => 'hi' }],
    ['an unknown network',    { network => 'othernet', target => $NICK, text => 'hi' }],
    ['a target with a comma', { network => $NET, target => "$NICK,stranger", text => 'hi' }],
    ['a target with a space', { network => $NET, target => "$NICK stranger", text => 'hi' }],
    ['a network with a slash', { network => '../../etc', target => $NICK, text => 'hi' }],
    ['a non-string text',     { network => $NET, target => $NICK, text => { a => 1 } }],
);

for my $case (@refused) {
    my ($what, $payload) = @$case;
    my $before = sent_count();
    my $r = ask($payload);
    ok(!$r->{ok}, "refused: $what");
    is(sent_count(), $before, "nothing was sent for: $what");
}

{
    my $before = sent_count();
    my $r = ask('this is not json');
    ok(!$r->{ok}, 'refused: a request that is not JSON');
    is(sent_count(), $before, 'nothing was sent for a non-JSON request');
}

# ⚠ A comma in the target would address two people, only one of whom the
# allow-list was checked against. The refusal above covers it; this states why.
{
    my $before = sent_count();
    my $r = ask({ network => $NET, target => uc($NICK), text => 'hi' });
    ok($r->{ok}, 'the allow-list matches case-insensitively, as IRC does');
    is(sent_count(), $before + 1, 'and the message is sent');
}

# ------------------------------------------------------------------- the echo
#
# The line number is half the importer's dedupe key. If this disagrees with the
# importer the hourly run writes a second copy and the message appears twice.

{
    my $dir = "$home/irclogs/$NET/2026/08/14";
    mkdir_p($dir);
    my $target_log = "$dir/" . lc($NICK) . ".log";

    # A file shaped like irssi's: the markers are counted too, because the
    # importer counts physical lines from 1 including everything it skips.
    open my $fh, '>', $target_log or die $!;
    print $fh "--- Log opened Fri Aug 14 09:00:00 2026\n";
    print $fh "09:01 < friend> morning\n";
    print $fh "09:02 -!- someone [x\@y] has joined #room\n";
    close $fh;

    my @tm = localtime(time);
    my $expected_date = sprintf('%04d-%02d-%02d', $tm[5] + 1900, $tm[4] + 1, $tm[3]);

    # Only meaningful on the day the fixture is dated for; otherwise the script
    # correctly looks at today's file and finds nothing.
    SKIP: {
        skip 'the echo fixture is dated 2026-08-14', 3 if $expected_date ne '2026-08-14';

        open my $ap, '>>', $target_log or die $!;
        print $ap "09:03 < me> the echoed line\n";
        close $ap;

        my $r = ask({ network => $NET, target => $NICK, text => 'the echoed line' });
        ok($r->{ok}, 'the send succeeded');
        ok($r->{logged}, 'the echo was found in the log');
        is($r->{line_no}, 4, 'the line number counts every physical line from 1');
    }
}

# A send whose echo is not in the log is still a send: reporting failure would
# say the message had not gone out, which is false.
{
    my $r = ask({ network => $NET, target => $CHAN, text => 'no log file for this' });
    ok($r->{ok}, 'a missing log does not turn a successful send into a failure');
    ok(!$r->{logged}, 'but it is reported as not logged');
}

sub mkdir_p {
    my ($path) = @_;
    my $so_far = '';
    for my $part (split m{/}, $path) {
        $so_far .= "$part/";
        mkdir $so_far;
    }
}

done_testing();

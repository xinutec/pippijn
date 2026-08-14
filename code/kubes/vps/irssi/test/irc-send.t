#!/usr/bin/env perl
#
# The transport, end to end: a real `irc-send` process against a real socket
# served by the real plugin.
#
# The plugin runs in a child process here because irssi is single-threaded and
# so is this: `irc-send` blocks waiting for an answer, so something else has to
# be running the accept loop. That is exactly the shape in production, where
# irssi is a different process from the ssh session.
#
# Run: perl test/irc-send.t

use strict;
use warnings;

use FindBin;
use lib "$FindBin::Bin/lib";

use IO::Socket::UNIX;
use IPC::Open2;
use JSON::PP;
use File::Temp qw(tempdir);
use POSIX qw(WNOHANG);
use Test::More;

my $home = tempdir(CLEANUP => 1);
$ENV{HOME} = $home;
mkdir "$home/.irssi";

open my $allow, '>', "$home/.irssi/archive-send.allow" or die $!;
print $allow "testnet friend\n";
close $allow;

my $sock_path = "$home/.irssi/archive-send.sock";
my $sender    = "$FindBin::Bin/../home/pippijn/bin/irc-send";

ok(-x $sender, 'irc-send is executable');

# The plugin, in a child, serving the socket for the life of this test.
my $pid = fork();
die "fork: $!" unless defined $pid;
if (!$pid) {
    require Irssi;
    no warnings 'once';    # %Irssi::SERVERS is only touched here, in the child
    my $server = Irssi::Test::Server->new(tag => 'testnet');
    $Irssi::SERVERS{testnet} = $server;
    do "$FindBin::Bin/../home/pippijn/.irssi/scripts/autorun/archive-send.pl";
    Irssi::run(5) for 1 .. 6;
    exit 0;
}

# Wait for the child to bind rather than sleeping a guessed interval.
my $waited = 0;
while (!-S $sock_path && $waited < 50) { select undef, undef, undef, 0.1; $waited++ }
ok(-S $sock_path, 'the plugin bound its socket');

my $json = JSON::PP->new->utf8->canonical;

# Run irc-send with $payload on stdin and return (decoded reply, exit code).
sub via_ssh {
    my ($payload, %opt) = @_;
    # The forced command sees whatever the client proposed; it must not matter.
    local $ENV{SSH_ORIGINAL_COMMAND} = $opt{original_command} // 'rm -rf /';
    my $out_fh;
    my $in_fh;
    my $child = open2($out_fh, $in_fh, $^X, $sender);
    print {$in_fh} (ref $payload ? $json->encode($payload) : $payload);
    print {$in_fh} "\n" unless $opt{no_newline};
    close $in_fh;
    my $reply = <$out_fh>;
    close $out_fh;
    waitpid $child, 0;
    my $status = $? >> 8;
    return (defined $reply ? eval { $json->decode($reply) } : undef, $status);
}

{
    my ($r, $status) = via_ssh({ network => 'testnet', target => 'friend', text => 'over the wire' });
    is($status, 0, 'a delivered request exits 0');
    ok($r && $r->{ok}, 'and the plugin accepted it');
    is($r->{text}, 'over the wire', 'the text arrived unaltered');
}

# ⚠ THE POINT OF THE FORCED COMMAND: what the client asks to run is ignored.
{
    my ($r, $status) = via_ssh(
        { network => 'testnet', target => 'friend', text => 'still just a message' },
        original_command => '/bin/sh -c "cat /etc/passwd"',
    );
    is($status, 0, 'a proposed shell command does not change the outcome');
    ok($r && $r->{ok}, 'the request is still handled as a request');
}

{
    my ($r, $status) = via_ssh({ network => 'testnet', target => 'stranger', text => 'hi' });
    is($status, 0, 'a refusal is still a working transport, so it exits 0');
    ok($r && !$r->{ok}, 'and the refusal is carried in the reply');
    like($r->{error}, qr/allow-list/, 'the reply says why');
}

# A second request in one connection must not be smuggled through behind the
# first: the transport forwards one line and drops the rest.
{
    my $one = $json->encode({ network => 'testnet', target => 'friend',   text => 'first' });
    my $two = $json->encode({ network => 'testnet', target => 'stranger', text => 'second' });
    my ($r, $status) = via_ssh("$one\n$two", no_newline => 1);
    is($status, 0, 'two framed requests are accepted by the transport');
    ok($r && $r->{ok}, 'the first is handled');
    is($r->{text}, 'first', 'and it is the first, not the second');
}

{
    my ($r, $status) = via_ssh('x' x 9000, no_newline => 1);
    isnt($status, 0, 'an oversized request fails rather than being truncated and sent');
}

kill 'TERM', $pid;
waitpid $pid, 0;

# With irssi gone the transport must fail loudly, not silently succeed.
{
    my ($r, $status) = via_ssh({ network => 'testnet', target => 'friend', text => 'nobody home' });
    isnt($status, 0, 'a dead irssi is a non-zero exit, not a quiet no-op');
}

done_testing();

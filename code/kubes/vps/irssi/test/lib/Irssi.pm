# Enough of irssi's Perl API to run archive-send.pl outside irssi.
#
# This is a stub so the parts that are ours can be tested — validation, the
# allow-list, framing, and the socket plumbing. It deliberately does NOT
# reimplement irssi: `send_message` records its arguments rather than
# connecting to anything, and the signal it emits is recorded rather than
# dispatched to real handlers.
#
# ⚠ WHAT THIS CANNOT TELL YOU, and the reason the live check still has to
# happen: whether `send_message` plus `signal_emit` is really what makes irssi
# write the echo to its autolog. That is a fact about irssi's own handlers, and
# a stub that answers it would only be restating what its author believed. It
# was settled by sending a real message and reading the real log.
#
# The event loop is real: `run` selects on the file descriptors the script
# registered and calls the callbacks it registered, so the accept/read/reply
# path under test is the one that runs in production.
package Irssi;

use strict;
use warnings;

our @INPUTS;      # { fd, func }
our @TIMEOUTS;    # { id, at, func }
our @PRINTS;
our @SIGNALS;     # emitted: [ name, @args ]
our %SETTINGS = (autolog_path => '~/irclogs/$tag/%Y/%m/%d/$0.log');
our %SERVERS;     # tag => server object

my $next_id = 1;

sub INPUT_READ () { 1 }

sub input_add {
    my ($fd, $cond, $func, $data) = @_;
    my $id = $next_id++;
    push @INPUTS, { id => $id, fd => $fd, func => $func };
    return $id;
}

sub input_remove {
    my ($id) = @_;
    @INPUTS = grep { $_->{id} != $id } @INPUTS;
}

sub timeout_add_once {
    my ($ms, $func, $data) = @_;
    my $id = $next_id++;
    push @TIMEOUTS, { id => $id, at => time + $ms / 1000, func => $func };
    return $id;
}

sub timeout_remove {
    my ($id) = @_;
    @TIMEOUTS = grep { $_->{id} != $id } @TIMEOUTS;
}

sub settings_get_str { return $SETTINGS{ $_[0] } }
sub server_find_tag  { return $SERVERS{ $_[0] } }
sub print            { push @PRINTS, $_[0] }
sub signal_add_first { }

sub signal_emit {
    my ($name, @args) = @_;
    push @SIGNALS, [ $name, @args ];
}

# Run the registered callbacks until nothing is readable for $quiet seconds.
sub run {
    my ($quiet) = @_;
    $quiet ||= 0.2;
    my $deadline = time + 5;
    while (time < $deadline) {
        my $rin = '';
        my %by_fd;
        for my $in (@INPUTS) {
            vec($rin, $in->{fd}, 1) = 1;
            $by_fd{ $in->{fd} } = $in->{func};
        }
        my $n = select(my $rout = $rin, undef, undef, $quiet);
        last if !$n || $n < 0;
        for my $fd (keys %by_fd) {
            next unless vec($rout, $fd, 1);
            $by_fd{$fd}->();
        }
    }
}

# A server that records rather than connects.
package Irssi::Test::Server;

sub new {
    my ($class, %args) = @_;
    return bless { connected => 1, sent => [], %args }, $class;
}

sub send_message {
    my ($self, $target, $text, $type) = @_;
    push @{ $self->{sent} }, { target => $target, text => $text, type => $type };
}

1;

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

use Time::HiRes ();

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

# ⚠ Sub-second deadlines, so `Time::HiRes` rather than `time`. The script's log
# settle is 120ms; against integer seconds it would land in the same tick as a
# 60-second parking timer and the two would be indistinguishable to
# `fire_timeouts`, which would then answer a waiting client "nothing yet" instead
# of handing it the line.
sub timeout_add_once {
    my ($ms, $func, $data) = @_;
    my $id = $next_id++;
    push @TIMEOUTS, { id => $id, at => Time::HiRes::time() + $ms / 1000, func => $func };
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

our %HANDLERS;    # signal name => [ code, … ]

sub signal_add_last {
    my ($name, $func) = @_;
    push @{ $HANDLERS{$name} }, $func;
}

sub signal_emit {
    my ($name, @args) = @_;
    push @SIGNALS, [ $name, @args ];
}

# What irssi does when a message arrives, as far as this script is concerned:
# call the handlers registered for that signal. Kept separate from `signal_emit`
# because the script EMITS its own echo signals and would otherwise re-enter its
# own handler — which is a real hazard in irssi too, and not one this stub should
# invent an answer to.
sub deliver {
    my ($name, @args) = @_;
    $_->(@args) for @{ $HANDLERS{$name} || [] };
}

# Run every timeout whose deadline has passed. The real irssi does this in its
# own loop; tests drive it so a deferred log read is deterministic rather than a
# sleep somebody has to guess the length of.
sub fire_timeouts {
    my $now = Time::HiRes::time();
    my @due = grep { $_->{at} <= $now } @TIMEOUTS;
    @TIMEOUTS = grep { $_->{at} > $now } @TIMEOUTS;
    $_->{func}->() for @due;
    return scalar @due;
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
    # `open` is the set of window items this server has: a joined channel or an
    # open query. It IS the send permission, so a test that wants a send refused
    # simply does not open that tab.
    return bless { connected => 1, nick => 'me', sent => [], open => {}, %args }, $class;
}

# irssi compares nicks and channel names case-insensitively; so does this, or a
# test would pass while the real lookup behaved differently.
sub window_item_find {
    my ($self, $name) = @_;
    my $key = lc $name;
    return exists $self->{open}{$key} ? { name => $self->{open}{$key} } : undef;
}

sub open_tab {
    my ($self, $name) = @_;
    $self->{open}{ lc $name } = $name;
}

sub close_tab {
    my ($self, $name) = @_;
    delete $self->{open}{ lc $name };
}

sub send_message {
    my ($self, $target, $text, $type) = @_;
    push @{ $self->{sent} }, { target => $target, text => $text, type => $type };
}

1;

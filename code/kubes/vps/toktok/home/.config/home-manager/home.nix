# Pippijn's personal home-manager override for the toktok dev
# container.
#
# COPY --chown=builder:users home /home/builder/ in the personal
# Dockerfile overwrites the symlink the base image places at
# /home/builder/.config/home-manager/home.nix (which points at the
# shared toktok-stack home.nix in the workspace). This regular file
# imports that same shared config and layers personal additions
# (currently: Claude Code) on top.
#
# Public toktok-stack: no Claude reference. The shared file at
# /src/workspace/tools/built/src/home/.config/home-manager/home.nix
# is unchanged. This override only ships in xinutec/toktok:latest
# (built locally from this repo), not in toxchat/toktok-stack:latest-dev.

{ config, pkgs, lib, ... }:

let
  # github:sadjow/claude-code-nix — community-maintained Claude Code
  # packaging. Tracks claude-code releases more closely than what
  # nixpkgs ships, and matches what we used previously.
  claude-code-flake = builtins.getFlake "github:sadjow/claude-code-nix";
  system = pkgs.stdenv.hostPlatform.system;
in
{
  imports = [
    /src/workspace/tools/built/src/home/.config/home-manager/home.nix
  ];

  home.packages = [
    claude-code-flake.packages.${system}.default
  ];
}

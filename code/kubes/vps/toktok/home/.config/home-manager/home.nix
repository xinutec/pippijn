{ config, pkgs, lib, ... }:

let
  claude-code-flake = builtins.getFlake "github:sadjow/claude-code-nix";
  system = pkgs.stdenv.hostPlatform.system;
in
{
  imports = [
    /src/workspace/tools/built/src/home/.config/home-manager/home.nix
  ];

  home.packages = [
    claude-code-flake.packages.${system}.default
    pkgs.tmux
  ];

  programs.neovim.plugins = lib.mkForce [ ];

  xdg.configFile."nvim/colors/jellybeans.vim".source =
    "${pkgs.vimPlugins.jellybeans-vim}/colors/jellybeans.vim";
}

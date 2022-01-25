{ config, pkgs, ... }:

let sys = (import <nixpkgs/nixos> {}).config; in
{
  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "pippijn";
  home.homeDirectory = "/home/pippijn";

  # Packages that should be installed to the user profile.
  home.packages = with pkgs; [
    git
    gnupg
    keychain
    screen
    unison
  ];

  # This value determines the Home Manager release that your
  # configuration is compatible with. This helps avoid breakage
  # when a new Home Manager release introduces backwards
  # incompatible changes.
  #
  # You can update Home Manager without changing this value. See
  # the Home Manager release notes for a list of state version
  # changes in each release.
  home.stateVersion = "21.11";

  home.sessionVariables = {
    EDITOR = "vi";
  };

  services.unison = {
    enable = sys.networking.hostName != "amun";

    # https://github.com/nix-community/home-manager/issues/2662
#   pairs = {
#     roots = [
#       "/home/pippijn/Photos"
#       "ssh://amun/home/pippijn/Photos"
#     ];
#   };
  };

  # Let Home Manager install and manage itself.
  programs.home-manager.enable = true;

  programs.ssh = {
    enable = true;

    matchBlocks = {
      irssi = {
        user = "irssi";
        hostname = "localhost";
        port = 2222;
      };
    };
  };

  programs.neovim = {
    enable = true;
    plugins = with pkgs.vimPlugins; [
      vim-nix
    ];

    extraConfig = ''
      nnoremap <C-l> :noh<CR><C-l>
      set viminfo='500,\"800
    '';
  };

  programs.zsh = {
    enable = true;
    autocd = true;
    enableSyntaxHighlighting = true;

    initExtra = ''
      unsetopt beep                   # don't beep, ever
      setopt hist_reduce_blanks       # remove superfluous blanks
      keychain id_rsa
      . .keychain/${sys.networking.hostName}-sh
    '';

    shellAliases = {
      gs = "gst";
      ll = "ls -l";
      reb = "sudo nixos-rebuild switch";
      hreb = "home-manager switch";
      k = "sudo kubectl";
      vi = "nvim";
    };

    history = {
      size = 1000000;
      save = 1000000;
      ignoreDups = true;
      extended = true;
      share = true;
      path = "${config.xdg.dataHome}/zsh/history";
    };

    oh-my-zsh = {
      enable = true;
      plugins = [ "docker" "git" ];
      theme = "cypher";
    };
  };
}

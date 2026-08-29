{ config, pkgs, lib, ... }:

let
  sys = (import <nixpkgs/nixos> { }).config;
  isMaster = sys.networking.hostName == "amun";
in {
  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "pippijn";
  home.homeDirectory = "/home/pippijn";

  # Packages that should be installed to the user profile.
  home.packages = with pkgs; [
    git         # version control
    git-crypt   # encrypted files in public git repos
    jq          # json query tool
    keychain    # ssh-agent
    # various scripts
    (python3.withPackages(ps: with ps; [
      requests
      types-requests
    ]))
    rclone      # sync with nextcloud
    screen      # terminal window manager
    unison      # sync with other machines
    rxvt-unicode
  ];

  # This value determines the Home Manager release that your
  # configuration is compatible with. This helps avoid breakage
  # when a new Home Manager release introduces backwards
  # incompatible changes.
  #
  # You can update Home Manager without changing this value. See
  # the Home Manager release notes for a list of state version
  # changes in each release.
  home.stateVersion = "23.05";

  home.sessionVariables = {
    EDITOR = config.programs.zsh.shellAliases.vi;

    NOCODB_TOKEN =
      let tokenFile = "${config.home.homeDirectory}/.nocodb"; in
      if builtins.pathExists tokenFile
        then lib.removeSuffix "\n" (builtins.readFile tokenFile)
        else "";
  };

  programs.gpg.enable = true;
  services.gpg-agent.enable = true;
  services.gpg-agent.pinentryPackage = pkgs.pinentry-curses;

  services.unison = {
    enable = false;

    pairs = if isMaster then {
#     picade = {
#       roots = [
#         "/home/pippijn/code/picade/home/pi"
#         "ssh://pi@10.100.0.100"
#         "ssh://pi@10.100.0.101"
#         "ssh://pi@10.100.0.102"
#         "ssh://pi@10.100.0.103"
#         "ssh://pi@10.100.0.104"
#       ];
#     };
    } else {
      home = {
        roots = [ "/home/pippijn" "ssh://amun" ];

        commandOptions.include = "ignores";
      };
    };
  };

  # Let Home Manager install and manage itself.
  programs.home-manager.enable = true;

  programs.ssh = {
    enable = true;

    # ⚠ NO GLOBAL `IdentityFile`. It used to name `~/.ssh/id_ed25519` and
    # `~/.ssh/id_rsa` — the RETIRED `pippijn@xinutec.org` pair, deleted from this
    # repo 2026-08-29 (health #1250) because a keypair whose private half was
    # published does not belong in a public checkout.
    #
    # Nothing replaces the lines, deliberately: naming NO identity restores
    # OpenSSH's built-in list, which already contains `~/.ssh/id_ed25519`. An
    # explicit `IdentityFile` REPLACES that list rather than adding to it
    # ([[reference_identityfile_replaces_the_default_list]]), so the old lines
    # were narrowing the search to two keys and one of them no longer exists.
    #
    # Checked before removing, on the Mac: the live key is
    # `SHA256:W+Hnhg9k…` (`pippijn@Mac.communityfibre.co.uk`), which is NOT the
    # pair this repo tracked (`SHA256:zO4GK9lb…`). `ssh -v root@isis` offers and
    # authenticates with the live one.

    matchBlocks = {
      "*" = {
        extraOptions = {
          ControlMaster = "auto";
          ControlPersist = "10m";
        };
      };
      irssi = {
        user = "irssi";
        hostname = "amun";
        port = 2230;
      };

      toktok = {
        user = "builder";
        hostname = "amun";
        port = 2223;
        extraOptions = {
          LogLevel = "QUIET";
          StrictHostKeyChecking = "off";
          UserKnownHostsFile = "/dev/null";
        };
      };

      toktok-dev = {
        user = "builder";
        hostname = "amun";
        port = 2224;
        extraOptions = {
          LogLevel = "QUIET";
          StrictHostKeyChecking = "off";
          UserKnownHostsFile = "/dev/null";
        };
      };
    };
  };

  programs.neovim = {
    enable = true;
    plugins = with pkgs.vimPlugins; [
      jellybeans-vim
      vim-nix
    ];

    extraConfig = ''
      colorscheme jellybeans

      set expandtab
      set nowrap
      set scrolloff=5
      set sidescrolloff=3
      set cursorline
      set backup
      set backupdir=~/.local/state/nvim/backup/
      set viminfo='500,\"800

      nnoremap <C-l> :noh<CR><C-l>
      map Q gqap

      au FileType bzl set ts=4 sw=4
    '';
  };

  programs.zsh = {
    enable = true;
    autocd = true;
    syntaxHighlighting = {
      enable = true;
    };

    initContent = ''
      unsetopt beep                   # don't beep, ever
      setopt hist_reduce_blanks       # remove superfluous blanks
      # ⚠ The retired `pippijn@xinutec.org` pair used to be chmod'ed and loaded
      # here at EVERY shell start. Deleted with the keys (health #1250); a
      # `chmod` of an absent file would error on every prompt on every host.
      # `keychain` with no key names still loads the agent and writes the file
      # sourced below.
      keychain --quiet
      . .keychain/${sys.networking.hostName}-sh

      # Fix some permissions in case they went wrong after git clone
      # and decrypt. `creb` rebuilds it.
      chmod 0600 $(cat .git-crypt/cache)

      # XXX: set this again, because something is overriding it.
      # TODO: remove once I figure out why.
      export EDITOR=${config.home.sessionVariables.EDITOR}
    '';

    shellAliases = {
      gs = "gst";
      ls = "ls -Fv --color=tty --group-directories-first --quoting-style=shell";
      l = "ls -l";
      ll = "ls -lah";
      reb = "sudo nixos-rebuild switch";
      hreb = "home-manager switch";
      creb = "git-crypt status | grep '^    encrypted: ' | cut -b16- > .git-crypt/cache";
      kubectl = "sudo kubectl";
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
      plugins = [ "docker" "git" "kubectl" ];
      theme = "cypher";
    };
  };
}

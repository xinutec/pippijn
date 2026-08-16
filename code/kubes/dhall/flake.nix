{
  description = "Typed fleet model — renders code/kubes/<app>/k8s manifests from Dhall";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.dhall
            pkgs.dhall-yaml
            # clusters.json — the app -> cluster map the deploy plan reads. JSON
            # rather than YAML because its consumer is Rust in another
            # repository; the map is built by this, never by printf.
            pkgs.dhall-json
            # normalize.py — semantic manifest comparison for --check
            (pkgs.python3.withPackages (ps: [ ps.pyyaml ]))
          ];
        };
      });
    };
}

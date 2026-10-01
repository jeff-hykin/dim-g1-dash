{
    description = "dim-g1-dash: onboard Unitree G1 dashboard, as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
        in {
            apps = forAllSystems (system: pkgs: {
                install = {
                    type = "app";
                    program = toString (pkgs.writeShellScript "install" ''
                        set -e
                        app=dim/apps/g1_dash
                        helper=$app/g1_helper_cpp
                        # fetch the backend's remote imports now so the first start is fast
                        ${pkgs.deno}/bin/deno cache --no-lock "$app/main.js"
                        ${if system == "aarch64-linux" then ''
                            # the G1's Jetson: a prebuilt helper (+ its CycloneDDS libs) is shipped
                            test -x "$helper/bin/g1_helper-linux-aarch64"
                            echo "dim-g1-dash: using shipped helper $helper/bin/g1_helper-linux-aarch64"
                        '' else if system == "x86_64-linux" then ''
                            # no shipped binary for x86_64 Linux: build the helper now instead of on first launch
                            echo "dim-g1-dash: building g1_helper with nix (compiles the Unitree + Livox SDKs, takes a few minutes)"
                            nix --extra-experimental-features "nix-command flakes" build -L "path:$PWD/$helper" -o "$helper/result"
                        '' else ''
                            # the helper is Linux-only (Jetson hardware); on a Mac only the panel loads
                            echo "dim-g1-dash: the onboard helper is Linux-only, skipping it on ${system}"
                        ''}
                    '');
                };
            });
        };
}

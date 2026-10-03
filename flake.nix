{
    description = "dim-g1-dash: onboard Unitree G1 dashboard, as a dimOS Desktop app — `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + React frontend + the native helper)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    inputs.g1-helper.url = "path:./g1_helper_cpp";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs, g1-helper }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAll (pkgs:
                let
                    system = pkgs.stdenv.hostPlatform.system;
                    # The helper (MID360 + RealSense + unitree_sdk2) is Linux-only. The Jetson (aarch64) runs the shipped
                    # prebuilt, built against its old glibc (g1_helper_cpp/build_prebuilt.sh); x86_64 Linux builds it here;
                    # a Mac gets the panel only.
                    helperEnvFor = target:
                        if target == "aarch64-linux" then "export G1_HELPER_DIR=${./g1_helper_cpp/bin}"
                        else if target == "x86_64-linux" then "export G1_HELPER=${g1-helper.packages.${target}.g1_helper}/bin/g1_helper"
                        else "";
                    helperEnv = helperEnvFor system;
                    # dimosApp for <arch> Linux, from any machine: its shell and deno are the target's (cache.nixos.org
                    # downloads); x86_64's helper is a native Linux build, so off Linux it comes from dimos-desktop.cachix.org
                    linuxApp = frontend: arch:
                        let linux = nixpkgs.legacyPackages."${arch}-linux"; in
                        pkgs.writeTextFile {
                            name = "dimos-app-server-${arch}-linux";
                            destination = "/bin/dimos-app-server";
                            executable = true;
                            text = "#!${linux.runtimeShell}\n${helperEnvFor "${arch}-linux"}\nexec ${linux.deno}/bin/deno run -A --no-lock ${./backend}/main.ts --frontend ${frontend} \"$@\"\n";
                        };
                in rec {
                    frontend = pkgs.buildNpmPackage {
                        pname = "g1-dash-frontend";
                        version = "0.1.0";
                        src = ./frontend;
                        # `nix build .#frontend` prints the right hash when package-lock.json changes
                        npmDepsHash = "sha256-B4IUoQXVqw3zCO7pE9vbNDMMJkJDMlRBGmVzz6gV3ps=";
                        installPhase = "cp -r dist $out";
                    };
                    dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
                        ${helperEnv}
                        exec ${pkgs.deno}/bin/deno run -A --no-lock ${./backend}/main.ts --frontend ${frontend} "$@"
                    '';
                    default = dimosApp;
                    dimosApp-aarch64-linux = linuxApp frontend "aarch64";
                    dimosApp-x86_64-linux = linuxApp frontend "x86_64";
                });
        };
}

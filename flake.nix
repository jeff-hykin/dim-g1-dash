{
    description = "dim-g1-dash: onboard Unitree G1 dashboard, as a dimOS Desktop app — `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + React frontend + the native helper)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    # the page's deno: nixos-25.11's 2.6.10, the version dimos pins (newer deno refuses packages younger than a day)
    inputs.nixpkgs-deno.url = "github:NixOS/nixpkgs/nixos-25.11";
    inputs.g1-helper.url = "path:./g1_helper_cpp";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs, nixpkgs-deno, g1-helper }:
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
                    pageDeno = nixpkgs-deno.legacyPackages.${system}.deno;
                    denoEnv = "export HOME=$TMPDIR DENO_DIR=$TMPDIR/deno DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1";
                    frontendFiles = paths: pkgs.lib.fileset.toSource { root = ./frontend; fileset = pkgs.lib.fileset.unions paths; };
                    # `deno install --frozen` (deno.lock pins every package) with network, so fixed-output. Its hash is per
                    # build machine (vite's native rollup and esbuild differ by OS and CPU): `deno task update-hashes` refreshes
                    # this machine's after frontend/deno.json or deno.lock change.
                    frontendModules = pkgs.stdenvNoCC.mkDerivation {
                        name = "g1-dash-frontend-modules";
                        src = frontendFiles [ ./frontend/deno.json ./frontend/deno.lock ];
                        nativeBuildInputs = [ pageDeno ];
                        buildPhase = ''
                            ${denoEnv}
                            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
                            deno install --frozen
                            # deno's own record of the install: not needed, and not byte-identical between installs
                            rm -f node_modules/.deno/.setup-cache.bin
                        '';
                        installPhase = "cp -R node_modules $out";
                        dontFixup = true;
                        outputHashMode = "recursive";
                        outputHashAlgo = "sha256";
                        outputHash = {
                            aarch64-darwin = "sha256-oO+P8sfp+UkDIpcmAzY4FqTDhNeop0Y4AHHbxGjwf+Q=";
                            x86_64-darwin = "";
                            x86_64-linux = "sha256-UHGas9HqIgcuMMgGITTDW7mGb93EZH7dw7TW0SpmCJw=";
                            aarch64-linux = "";
                        }.${system};
                    };

                    pageFiles = frontendFiles [ ./frontend/deno.json ./frontend/deno.lock ./frontend/index.html ./frontend/vite.config.ts ./frontend/tools ./frontend/src ];
                    # dimos-react as esm.sh builds its tag (frontend/tools/esm_fetch.ts): a vite build with network that
                    # keeps only what it fetched, so fixed-output; the same on every system. `deno task update-hashes` refreshes it.
                    frontendEsm = pkgs.stdenvNoCC.mkDerivation {
                        name = "g1-dash-frontend-esm";
                        src = pageFiles;
                        nativeBuildInputs = [ pageDeno ];
                        buildPhase = ''
                            ${denoEnv}
                            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
                            cp -R ${frontendModules} node_modules
                            chmod -R u+w node_modules
                            ESM_CACHE=$TMPDIR/esm deno run -A --cached-only --node-modules-dir=manual npm:vite build --logLevel warn
                        '';
                        installPhase = "cp -R $TMPDIR/esm $out";
                        dontFixup = true;
                        outputHashMode = "recursive";
                        outputHashAlgo = "sha256";
                        outputHash = "sha256-i1apDkHmXSVopbvBbhYKHWqaKqD1yKvh9W+2KnSRFAc=";
                    };

                    # the page: React + Vite against those modules and that esm.sh cache, offline
                    frontend = pkgs.stdenvNoCC.mkDerivation {
                        name = "g1-dash-frontend";
                        src = pageFiles;
                        nativeBuildInputs = [ pageDeno ];
                        buildPhase = ''
                            ${denoEnv}
                            cp -R ${frontendModules} node_modules
                            chmod -R u+w node_modules
                            ESM_CACHE=${frontendEsm} ESM_OFFLINE=1 deno run -A --cached-only --node-modules-dir=manual npm:vite build
                        '';
                        installPhase = "cp -R dist $out";
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

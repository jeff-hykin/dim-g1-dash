{
    description = "dim-g1-dash: onboard Unitree G1 dashboard, as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    inputs.dim-app.url = "github:jeff-hykin/dim-app/v0.6.0";
    inputs.g1-helper.url = "path:./dim/apps/g1_dash/g1_helper_cpp";

    outputs = { self, nixpkgs, dim-app, g1-helper }: {
        packages = dim-app.lib.forAllSystems nixpkgs (pkgs:
            let
                system = pkgs.stdenv.hostPlatform.system;
                server = dim-app.lib.mkDimosApp {
                    inherit pkgs;
                    name = "dim-g1-dash";
                    src = self;
                    frontend = "dim/apps/g1_dash/frontend";
                    backend = "dim/apps/g1_dash/main.js";
                };
            in {
                # aarch64 Linux (the Jetson) runs the shipped prebuilt beside main.js; x86_64 Linux gets the helper built
                # here; on a Mac only the panel loads (the helper is Linux-only)
                dimosApp =
                    if system == "x86_64-linux" then
                        pkgs.writeShellScriptBin "dimos-app-server" ''
                            export G1_HELPER=${g1-helper.packages.${system}.g1_helper}/bin/g1_helper
                            exec ${server}/bin/dimos-app-server "$@"
                        ''
                    else
                        server;
            });
    };
}

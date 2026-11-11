# Third-party source notices

## SealHUD

Source: https://github.com/sealhud/sealhud_source/tree/d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b

The Webpack configuration, layout/profile and drag/scale behavior, widget styling and timing presentation adapt focused portions of SealHUD. Adapted files identify their source in their headers. Unrelated SealHUD startup services, debug snapshot persistence and game-provided delta calculations are not imported.

Copyright (c) 2026 Diego Junges and contributors.

The upstream `LICENSE` grants the MIT License, reproduced verbatim in [LICENSES/SealHUD-MIT.txt](LICENSES/SealHUD-MIT.txt). Upstream package metadata says ISC while its LICENSE and README say MIT; this project preserves the explicit upstream LICENSE grant and notices.

## RaceRoom API

API declarations and documentation consulted at https://github.com/kwstudios-sweden/r3e-api/tree/e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb. The native API repository uses the Unlicense. This application consumes its documented bridge field names; it does not bundle a native shared-memory reader.

## Installed libraries

React, Webpack, core-js and other dependencies retain their package-distributed licenses and notices. Dependency versions and integrity checks are recorded in `package-lock.json`; no upstream branding assets or fonts are copied without their separate licensing context.

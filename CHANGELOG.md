# Changelog

## [0.3.0](https://github.com/parisnakitakejser/sundhedmcp/compare/v0.2.0...v0.3.0) (2026-11-22)


### Features

* /api/v1 JSON API and /connect/record page ([ee6bb8e](https://github.com/parisnakitakejser/sundhedmcp/commit/ee6bb8e56a2196269b894a511b4105bfb7f605a9))
* /api/v1 JSON API and /connect/record page over the saved copy ([386a822](https://github.com/parisnakitakejser/sundhedmcp/commit/386a822be02194370817268f26949a270eeb7d6a))
* auto-renew prescriptions from the dashboard ([cb04fff](https://github.com/parisnakitakejser/sundhedmcp/commit/cb04fffce226df845684082fd3e0585db50af6ad))
* auto-renew prescriptions from the dashboard ([ed9ddcd](https://github.com/parisnakitakejser/sundhedmcp/commit/ed9ddcda5bd077434ba57b4c416c5e25800598ef))
* dashboard for the saved copy, and API tokens for your own scripts ([9a31e58](https://github.com/parisnakitakejser/sundhedmcp/commit/9a31e580076f4699064fe9f96a03f344c4df6092))
* dashboard for the saved copy, and API tokens for your own scripts ([093b3d8](https://github.com/parisnakitakejser/sundhedmcp/commit/093b3d82c25207b098ff04eba8f2f529367ff5a7))
* get_appointments, the Aftaler page as a tool ([81931ed](https://github.com/parisnakitakejser/sundhedmcp/commit/81931ed07c9a88fc32615e0027c7a386eb36aa1c))
* get_appointments, the Aftaler page as a tool ([eb9a989](https://github.com/parisnakitakejser/sundhedmcp/commit/eb9a989b54083a2ae297a794aa256d545e1dca41))
* Helm chart with kagent wiring, and API tokens for /mcp ([7411409](https://github.com/parisnakitakejser/sundhedmcp/commit/7411409704a2a0683495f717c78848caddb8070a))
* Helm chart with kagent wiring, and API tokens for /mcp ([ee6f3ad](https://github.com/parisnakitakejser/sundhedmcp/commit/ee6f3adbc657d2c86ee33702e2d545265b375065))
* keep the saved copy current while the session lasts ([abf7d09](https://github.com/parisnakitakejser/sundhedmcp/commit/abf7d0982348eef6f751f63862f6e0edd6542471))
* keep the saved copy current while the session lasts ([c2f945f](https://github.com/parisnakitakejser/sundhedmcp/commit/c2f945fb426f133a7821fd656fd8c7ada7ba8a40))
* keep the saved copy in encrypted SQLite or PostgreSQL storage ([e666084](https://github.com/parisnakitakejser/sundhedmcp/commit/e6660843d40356dbb8735514102dfa778aea32d9))
* keep the saved copy in encrypted SQLite or PostgreSQL storage ([42f0c91](https://github.com/parisnakitakejser/sundhedmcp/commit/42f0c91eeff8f8289e3c14642c83b6a9d2463d2f))
* keep the sundhed.dk login across restarts ([1242053](https://github.com/parisnakitakejser/sundhedmcp/commit/12420535bfde647cd04e98ff18c72b3e960f2e43))
* keep the sundhed.dk login across restarts ([cd34c83](https://github.com/parisnakitakejser/sundhedmcp/commit/cd34c83b0634868553d1920758e63d0ce3c4a173))
* OpenTelemetry traces, metrics and logs, with a Perses dashboard ([e3c9d52](https://github.com/parisnakitakejser/sundhedmcp/commit/e3c9d52a2899868dfcefa4800ee9c96045d1b51d))
* OpenTelemetry traces, metrics and logs, with a Perses dashboard ([1fc1c87](https://github.com/parisnakitakejser/sundhedmcp/commit/1fc1c8794ad61ffe1f4af1db2e2655fcb0bea0ea))
* prescription renewal behind SUNDHEDMCP_ALLOW_RENEWAL ([d921ab4](https://github.com/parisnakitakejser/sundhedmcp/commit/d921ab46cc4ca5f15949828bad8d8952c2fee76a))
* prescription renewal behind SUNDHEDMCP_ALLOW_RENEWAL ([b3ad0cd](https://github.com/parisnakitakejser/sundhedmcp/commit/b3ad0cdf95e2829e563c91f761f8b8129500ca3c))
* session bar at the top of every record page ([0e605bc](https://github.com/parisnakitakejser/sundhedmcp/commit/0e605bc8dde0866bcc63a4957a331124ea46b5b9))
* session bar at the top of every record page ([c50488d](https://github.com/parisnakitakejser/sundhedmcp/commit/c50488dcd449372304ac751b6c5e5d7d42170197))
* several people in hosted mode, signed in with OIDC ([db3eeb2](https://github.com/parisnakitakejser/sundhedmcp/commit/db3eeb22bd7d2382ba3b069d66824aa1a07356d9))
* several people in hosted mode, signed in with OIDC ([be53dfc](https://github.com/parisnakitakejser/sundhedmcp/commit/be53dfc40a91ef3d1102d5af7fae2188f5fdac93))
* show a busy notice while the next page loads ([e4781f6](https://github.com/parisnakitakejser/sundhedmcp/commit/e4781f668c67649424321baaba13f5c2771073e7))
* show a busy notice while the next page loads ([8afcf81](https://github.com/parisnakitakejser/sundhedmcp/commit/8afcf817918f0b408ab60c2b1ca51558cbf44dda))
* show how the sundhed.dk session is doing ([0cb3f5e](https://github.com/parisnakitakejser/sundhedmcp/commit/0cb3f5ed5e790b7906dc9857314b93f9d7075e9f))
* show how the sundhed.dk session is doing ([a1aaf27](https://github.com/parisnakitakejser/sundhedmcp/commit/a1aaf27e06ffed1a6d09fcf455b49e598164ba5c))


### Bug Fixes

* accept dashboard form posts sent with Origin: null ([e0a5e43](https://github.com/parisnakitakejser/sundhedmcp/commit/e0a5e43a18e5750dcb76a993f4516830e17fa2d8))
* catch a kept login that sundhed.dk only half accepts ([7ce4264](https://github.com/parisnakitakejser/sundhedmcp/commit/7ce426460e8b69a2c70885ba600713fc007c7491))
* catch a kept login that sundhed.dk only half accepts ([cef69e7](https://github.com/parisnakitakejser/sundhedmcp/commit/cef69e7c62f17cdc4da712358e81f1cb2552d881))
* **chart:** keep the dashboard's HTTP panels to sundhedmcp's own metrics ([d1c0284](https://github.com/parisnakitakejser/sundhedmcp/commit/d1c02843e1569aef7d969f3e5c3799f2289ef108))
* **chart:** keep the dashboard's HTTP panels to sundhedmcp's own metrics ([a75fe66](https://github.com/parisnakitakejser/sundhedmcp/commit/a75fe66f5c0a861fd51abda2ff823bb41ed5a73d))
* what the Jaeger traces showed ([fbb3554](https://github.com/parisnakitakejser/sundhedmcp/commit/fbb3554dcaaea557de2ef24fd578788d68332102))
* what the Jaeger traces showed ([a4e42cb](https://github.com/parisnakitakejser/sundhedmcp/commit/a4e42cbad0e70409fe0c178e4083f1c42d0a7c05))

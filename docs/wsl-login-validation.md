# Validate an additional-account login in WSL

Real acceptance requires a human to complete the official CLI flow from Quorb's
terminal on Windows/WSL. The synthetic laboratory is not a substitute.

## Interactive acceptance

1. Identify the candidate commit and the matching Quorb artifact to test. On
   Windows, open that artifact and choose a test distro in Quorb's WSL settings.
2. Choose or add a test additional account in the app, with a session folder
   separate from all existing accounts. Note the current result for another
   account so it can be checked again later.
3. Start the additional-account login **from Quorb**. In the terminal Quorb
   opens, complete the official CLI and browser flow yourself.
4. Use Quorb's account check to confirm the additional account works. Restart
   Quorb and check it again; also confirm the other account remains unchanged.
   Finding a session file alone does not demonstrate that an account works.
5. Report only sanitized pass/fail metadata: candidate commit/artifact, platform
   and distro family/version, and the result of each step. Do not include
   credential contents, account IDs, raw logs, or screenshots with personal data.

## Evidence boundaries

- Compiling ignored Windows tests does not run them or validate login. The legacy
  ignored checks require a disposable, pre-provisioned guest; do not run them on
  a personal distro.
- The Unix synthetic lab exercises the generated shell argv and the mocked
  session-resolver seam using an isolated fixture. It does not run `wsl.exe`,
  launch Quorb's terminal, contact a provider, or prove interactive login.
- S6 / T6 remains pending until a human performs the interactive acceptance
  above against the identified candidate and reports sanitized results.

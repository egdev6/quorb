# W0 evidence — Windows/WSL discovery (lab for Quorb #90)

Evidence collected on hosted `windows-latest` runners in the temporary lab
`sosan/wsl-w0-lab`; the two workflows that produced it (`w0-evidence.yml`,
`w0-names.yml`) are included in this branch for reproducibility. Raw artifacts
live in the lab runs; this document consolidates only their outcomes.

- Baseline run: <https://github.com/sosan/wsl-w0-lab/actions/runs/38990859346>
- Names run: <https://github.com/sosan/wsl-w0-lab/actions/runs/38991093656>

## Environment observed

| Item | Value | Source |
| --- | --- | --- |
| WSL version | 3.0.1.0 | `version-default.txt` |
| Kernel | 6.18.40.1-1 | `version-default.txt` |
| Windows | 10.0.26100 (Server 2025 image) | `version-default.txt`, `host-info.txt` |
| Initial distro state | zero installed | `list-verbose-default.txt` |

## Findings for Quorb contract (W1 input)

### F1 — Output encoding is dual-behavior

Without `WSL_UTF8=1`, `wsl.exe --status / --version / --list` writes **UTF-16LE without BOM**
to a redirected file (captured raw bytes + hex head in `hex-head-list-verbose.txt`,
`encoding-shape.txt` from the baseline run). With `WSL_UTF8=1` the same outputs are plain UTF-8.
Quorb must pin output encoding handling: either always set `WSL_UTF8=1` for child processes or
decode both shapes; naive per-line parsing of default output produces `\x00`-interleaved text.

### F2 — Exit codes are noisy and undocumented in practice

| Case | Exit code | Evidence |
| --- | --- | --- |
| `wsl --list --all` with installed distros | 0 | `exit-codes.txt` |
| `wsl --list --all` with zero distros (message, no stderr) | -1 | run 38991093656 step 2 + `exit-codes.txt` contrast |
| `wsl --list --verbose` zero distros | -1 | `list-verbose-default.txt` (baseline run) |
| `wsl -d <missing>` | -1, text `Wsl/Service/WSL_E_DISTRO_NOT_FOUND` | `zero-distro-missing.txt`, `exit-codes.txt` |
| invalid flag | -1, `Invalid command line argument` | `exit-codes.txt` |
| empty name (`-d " "`) | -1, same DISTRO_NOT_FOUND text | `exit-codes.txt` |

Quorb cannot rely on exit codes alone; parsing the `Wsl/Service/...` error token in the output
text is required to distinguish missing-distro from invalid-args and zero-distro states.

### F3 — Distro names: registration rejects spaces and non-ASCII

`wsl --import` with wsl 3.0.1 rejects:
- `Hello World` (ASCII + space) → `Wsl/Service/RegisterDistro/E_INVALIDARG`
- `PruebaÑ` (latin unicode) → same, via pwsh and via cmd + `chcp 65001`
- `Quorb-Проверка` (cyrillic), `Quorb-世界` (CJK) → same

The error message echoes the name back intact in every shell, which shows the rejection comes
from WSL's own validation, not from pwsh argument mangling. Names with dots/dashes/underscores
were accepted (`CmdSpaceName_test` import ok; `--set-default` ok; `wsl -d` target ok), and
`--list --verbose` prints the name correctly under `WSL_UTF8=1`.

Implication for #90: through supported paths, listed distro names are usually store names
(`Ubuntu-22.04`, `Debian`), but defensive parsing and simulation tests for spaces/non-ASCII
still make sense for legacy/edge states; registration-level rejection is now evidenced.

### F4 — Wake semantics are exactly what the ODD assumed

| Operation | Effect | Evidence |
| --- | --- | --- |
| 20x `wsl --list --quiet` on Stopped distro | **does not wake** (state stays Stopped) | `list-does-not-wake.txt` |
| a single `wsl -d X -- uname` | wakes → Running | `wake-and-run.txt`, `running-list.txt` |
| `wsl --terminate X` | Running → Stopped | `terminated-list.txt` |
| killing the launcher process of a sleeping `wsl` command | **does not stop the distro** (stays Running) | `timeout-hang.txt` |

Quorb timeouts cannot rely on killing the spawned process: terminating a hung invocation needs
`wsl --terminate <distro>` (or its session terminator), which the W1 contract must state as the
stop primitive.

### F5 — Default user / home resolution works without name assumptions

Baseline run `user-default.txt`:
- imported distro default user = `root` until `/etc/wsl.conf` `[user] default=quorbuser` + terminate
- after config: `whoami` → `quorbuser`, `HOME=/home/quorbuser`, `getent passwd` resolves home
- Windows user (`runneradmin`) is unrelated to the Linux user — the "do not infer Windows
  username" assumption is confirmed as required
- `-u root` override works independently of `wsl.conf`

### F6 — Zero-distro diagnostics are distinct and reproducible

Fresh runner with zero distros: `--list` prints
`Windows Subsystem for Linux has no installed distributions.` and exits -1; targeting any distro
name returns `Wsl/Service/WSL_E_DISTRO_NOT_FOUND` -1. WSL itself may be installed with zero
distros (this exact state was the lab environment), so "WSL absent" vs "zero distros" need
separate probes (`--version` vs `--list`).

### F7 — UNC access to home: does it wake a stopped distro?

*(run pending — captured by the new "UNC access to home without waking the distro" step)*

Question for the W1 decision: can Quorb resolve the Linux home via
`\\wsl.localhost\<distro>\home\<user>` **without waking** a Stopped distro? `wsl --list`
does not wake (F4), but `Test-Path` / `Get-ChildItem` over the UNC namespace is a different
mechanism (9P/Plan9 server) and must be observed separately.

The step terminates `quorb_w0`, then:
1. `Test-Path \\wsl.localhost\quorb_w0\home\quorbuser` while Stopped;
2. re-checks `--list --verbose` state right after;
3. `Get-ChildItem` of the same path while Stopped; re-checks state;
4. control: `wsl -d quorb_w0 -- whoami` (known to wake — F4) -> confirms the state detector works.

If the distro stays Stopped after (1)-(3), Quorb can read the home path without activating
it — relevant for the "enumerar no debe despertar" policy and for W2's home discovery.

### F8 — Shell semantics for detection and login

*(run pending — captured by the new "Shell semantics for detection and login" step)*

W1 must decide a "shell strategy for detection/login". This step observes what a plain
`wsl -d X -- <cmd>` actually runs (not the app's choice, the distro's), so the contract can
name it:

- `wsl -d X -- sh -c 'echo SHELL=$SHELL'` — the implicit shell and `$PS1`-less env.
- `wsl -d X -e sh -c ...` — explicit `-e` form.
- `wsl -d X -- bash -lc` vs `bash -c` vs `/bin/sh -lc` — login-shell PATH differences.
- `wsl -d X -- 'echo $PATH'` — default PATH for a non-interactive, non-login command.

Implication for login CLI: if `claude login` is installed in a shell-init-only location
(nvm/volta paths), a plain `wsl -d X -- claude login` may not see it; the contract must say
whether Quorb forces a login shell (`-e bash -lc`) or accepts the plain PATH.

### F9 — wsl.exe location in the hosted runner

*(run pending — captured by the "wsl.exe location and non-TTY stdin behavior" step)*

`(Get-Command wsl.exe).Source` on `windows-latest` (Server 2025 image). Assumption
"`wsl` in PATH" holds here, but the W1 contract should name the lookup order (System32 first,
then `%ProgramFiles%\WSL\wsl.exe` for older images) and keep "WSL absent" as a distinct
diagnostic from "not in PATH".

### F10 — stdin non-TTY from a GUI-like context

*(run pending — same step as F9)*

Quorb launches processes from a GUI app (no console/TTY), with redirected stdin/stdout.
The step contrasts the same command via `pwsh` (already redirected by the runner) and via
`cmd /c`, plus a stdin-echo test (`echo hi | wsl -d X -- sh -c 'read x; echo got=[$x]'`).
If WSL treats redirected stdin as a pipe (not a TTY), detection/login from the app should
work without a console; if it requires a TTY, W1 must specify the fallback.

## Limits of this evidence

Hosted runners prove real wsl.exe behavior on Windows Server 2025 image, but they do not cover:
- store-installed distros and first-boot OOBE user creation (declared: if the first
  read of the home wakes the distro via UNC, OOBE completes at that moment — input
  for the W2 test plan, not for the W1 contract).
- WSL not installed at all (couldn't be tested without removing system components).
- developer machine setups with multiple distros and `wsl.conf` variations (F11
  multi-distro step is optional; a single-distro + a unicode-named distro is the current coverage).
- GUI session / interactive login flows.

Dates: evidence captured 2026-10-17.

## Pending runs (F7–F10)

The evidence for F7/F8/F9/F10 is produced by the three new steps added to
`.github/workflows/w0-evidence.yml` in this branch. Until the workflows are
re-run on this repository (`sosan/quorb`, branch `investigacion/w0-wsl-lab` —
`gh workflow run w0-evidence.yml --repo sosan/quorb --ref investigacion/w0-wsl-lab`),
the sections above cite the planned artifacts (`raw/unc-wake.txt`,
`raw/shell-semantics.txt`, `raw/wsl-path.txt`, `raw/stdin-tty.txt`) and the
questions they answer; the runs and final artifacts are filled in when the
workflows are re-executed (on `sosan/quorb`, not the old lab mirror) and the
doc is updated.

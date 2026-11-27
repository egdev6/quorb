#!/usr/bin/env node
// DRAFT — evidence runner for the Nexo hub integration (#281).
//
// Starts the plugin's `sim_hub` fixture and the built app, drives the hub with
// the commands of the fixture and turns the transcript into the cases that can
// be checked from CI. The transcript is written next to the job log so it can
// be attached to the pull request.
//
// What CI can see is the protocol: the registration, the menu, the unified
// toggle, the recovery after a dropped connection and the `quit_result`.
// Whether the icon is *visible* in the Windows tray is not observable from
// here and stays a manual check.
//
//   NEXO_SIM_HUB   ruta al ejecutable de sim_hub
//   NEXO_APP       ruta al ejecutable de Quorb
//   NEXO_TRANSCRIPT  fichero donde volcar la transcripción (opcional)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { evaluate, parseTranscript, summarize } from './transcript.mjs';

const HUB = process.env.NEXO_SIM_HUB;
const APP = process.env.NEXO_APP;
const OUT = process.env.NEXO_TRANSCRIPT ?? 'nexo-evidence-transcript.txt';
const TIMEOUT = (process.env.NEXO_TIMEOUT_MS ?? 180_000) | 0;

if (!HUB || !APP) {
  console.error('Faltan NEXO_SIM_HUB y/o NEXO_APP.');
  process.exit(2);
}

let output = '';
const waiters = [];

const pump = (chunk) => {
  output += chunk;
  for (const waiter of [...waiters]) {
    if (waiter.pattern.test(output)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(output);
    }
  }
};

/** Espera a que la transcripción case con el patrón. */
const waitFor = (pattern, description, timeout = TIMEOUT) =>
  new Promise((resolve, reject) => {
    if (pattern.test(output)) {
      resolve(output);
      return;
    }
    const waiter = { pattern, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error(`Timeout esperando ${description}. Transcripción hasta ahora:\n${output}`));
    }, timeout);
    waiters.push(waiter);
  });

const send = (command) => {
  if (!hub.stdin.writable) throw new Error('el hub ya no acepta comandos');
  hub.stdin.write(`${command}\n`);
};

const hub = spawn(HUB, [], { stdio: ['pipe', 'pipe', 'pipe'] });
hub.stdout.setEncoding('utf8');
hub.stderr.setEncoding('utf8');
hub.stdout.on('data', pump);
hub.stderr.on('data', pump);

let app = null;
const cleanup = () => {
  try {
    if (app && app.exitCode === null) app.kill();
  } catch {
    /* nada que hacer */
  }
  try {
    if (hub.exitCode === null) hub.kill();
  } catch {
    /* nada que hacer */
  }
};
process.on('exit', cleanup);

try {
  await waitFor(/^Listening on /m, 'a que el hub abra el pipe');
  console.log('· hub escuchando');

  app = spawn(APP, [], { stdio: 'ignore' });
  let appExit = null;
  app.on('exit', (code) => {
    appExit = code;
  });

  await waitFor(/^Registered app: /m, 'a que la app se registre');
  console.log('· app registrada');
  await waitFor(/^Menu replacement: /m, 'a que la app envíe su menú');
  console.log('· menú recibido');

  send('u');
  await waitFor(/^Unified: false$/m, 'la alternancia del modo unificado');
  send('u');
  await waitFor(/^Unified: true$/m, 'la vuelta al modo unificado');
  console.log('· modo unificado alternado');

  send('d');
  await waitFor(/^Dropping connection/m, 'la caída de la conexión');
  await waitFor(/^Registered app: /m, 'el re-registro tras la caída', 120_000);
  console.log('· la app volvió a registrarse tras la caída');

  send('q');
  await waitFor(/<-\s*\{"v":1,"type":"quit_result"/m, 'el resultado del «Salir»', 60_000);
  await waitFor(/<-\s*\{"v":1,"type":"bye"/m, 'la despedida de la app', 60_000);
  console.log('· «Salir» respondido y app despedida');

  const deadline = Date.now() + 60_000;
  while (appExit === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`· la app terminó con código ${appExit ?? 'n/d'}`);

  const parsed = parseTranscript(output);
  const cases = evaluate(parsed);
  writeFileSync(OUT, output);
  console.log(`\n${summarize(cases)}\n`);
  console.log(`Transcripción completa en ${OUT}`);
  if (cases.some((entry) => !entry.ok)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  writeFileSync(OUT, output);
  console.error(`Transcripción guardada en ${OUT}`);
  process.exitCode = 1;
} finally {
  cleanup();
}

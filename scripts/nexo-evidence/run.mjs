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
// Whether the icon is *visible* in the Windows tray is not observable from here
// (the runner has no desktop shell, and a failed tray creation is only logged by
// the plugin) and stays a manual check.
//
//   NEXO_SIM_HUB     ruta al ejecutable de sim_hub
//   NEXO_APP         ruta al ejecutable de Quorb
//   NEXO_TRANSCRIPT  fichero donde volcar la transcripción (opcional)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { evaluate, parseTranscript, summarize } from './transcript.mjs';
import { createWatcher } from './watcher.mjs';

const HUB = process.env.NEXO_SIM_HUB;
const APP = process.env.NEXO_APP;
const OUT = process.env.NEXO_TRANSCRIPT ?? 'nexo-evidence-transcript.txt';
const OUT_APP = process.env.NEXO_APP_LOG ?? 'nexo-evidence-app.log';
const TIMEOUT = (process.env.NEXO_TIMEOUT_MS ?? 120_000) | 0;

if (!HUB || !APP) {
  console.error('Faltan NEXO_SIM_HUB y/o NEXO_APP.');
  process.exit(2);
}

const transcript = createWatcher({ timeout: TIMEOUT });

const hub = spawn(HUB, [], { stdio: ['pipe', 'pipe', 'pipe'] });
hub.stdout.setEncoding('utf8');
hub.stderr.setEncoding('utf8');
hub.stdout.on('data', (chunk) => transcript.push(chunk));
hub.stderr.on('data', (chunk) => transcript.push(chunk));

const send = (command) => {
  if (!hub.stdin.writable) throw new Error('el hub ya no acepta comandos');
  hub.stdin.write(`${command}\n`);
};

let app = null;
let appExit = null;
// La salida de la app se guarda aparte: si el hub no recibe respuesta a un
// `quit`, el motivo (una ventana que no se crea, un pánico en el hilo de UI)
// solo está aquí.
let appLog = '';
const cleanup = () => {
  for (const child of [app, hub]) {
    try {
      if (child && child.exitCode === null) child.kill();
    } catch {
      /* nada que hacer */
    }
  }
};
process.on('exit', cleanup);

const appTail = () => appLog.trim().split('\n').slice(-40).join('\n');

const dump = (message) => {
  writeFileSync(OUT, transcript.text());
  writeFileSync(OUT_APP, appLog);
  console.error(`${message}\nTranscripción guardada en ${OUT}\nLog de la app guardado en ${OUT_APP}`);
  if (appLog.trim()) console.error(`\n--- salida de la app ---\n${appTail()}`);
  process.exitCode = 1;
};

try {
  await transcript.waitFor(/^Listening on /, 'a que el hub abra el pipe');
  console.log('· hub escuchando');

  // El cursor se toma antes de arrancar la app: así la espera del registro no
  // se satisface con nada anterior.
  let from = transcript.mark();
  app = spawn(APP, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.setEncoding('utf8');
  app.stderr.setEncoding('utf8');
  app.stdout.on('data', (chunk) => {
    appLog += chunk;
  });
  app.stderr.on('data', (chunk) => {
    appLog += chunk;
  });
  app.on('exit', (code) => {
    appExit = code;
  });

  await transcript.waitFor(/^Registered app: /, 'a que la app se registre', { from });
  console.log('· app registrada');
  await transcript.waitFor(/^Menu replacement: /, 'a que la app envíe su menú', { from });
  console.log('· menú recibido');

  from = transcript.mark();
  send('u');
  await transcript.waitFor(/^Unified: false$/, 'la alternancia del modo unificado', { from });

  from = transcript.mark();
  send('u');
  await transcript.waitFor(/^Unified: true$/, 'la vuelta al modo unificado', { from });
  console.log('· modo unificado alternado');

  // El cursor se toma ANTES de pedir la caída: el re-registro que hay que
  // esperar es el de después, no el del arranque.
  from = transcript.mark();
  send('d');
  await transcript.waitFor(/^Dropping connection/, 'la caída de la conexión', { from });
  await transcript.waitFor(/^Registered app: /, 'el re-registro tras la caída', { from });
  console.log('· la app volvió a registrarse tras la caída');

  from = transcript.mark();
  send('q');
  await transcript.waitFor(/^-> .*"type":"quit"/, 'a que el hub pida el «Salir»', { from, timeout: 30_000 });
  await transcript.waitFor(/^<- .*"type":"quit_result"/, 'el resultado del «Salir»', { from, timeout: 60_000 });
  await transcript.waitFor(/^<- .*"type":"bye"/, 'la despedida de la app', { from, timeout: 30_000 });
  console.log('· «Salir» respondido y app despedida');

  const deadline = Date.now() + 60_000;
  while (appExit === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`· la app terminó con código ${appExit ?? 'no terminó a tiempo'}`);

  const cases = evaluate(parseTranscript(transcript.text()));
  writeFileSync(OUT, transcript.text());
  writeFileSync(OUT_APP, appLog);
  console.log(`\n${summarize(cases)}\n`);
  console.log(`Transcripción completa en ${OUT}`);
  if (cases.some((entry) => !entry.ok)) process.exitCode = 1;
  // Una app que no sale tras un «Salir» aceptado es un fallo, no un detalle.
  if (appExit !== 0) process.exitCode = 1;
} catch (error) {
  dump(error instanceof Error ? error.message : String(error));
} finally {
  cleanup();
}

// The plugin's entry. The host injects the `eveCyno` global into the page; the API package gives types only, so nothing from it is
// bundled and the page has no runtime dependency.
import type { EveCyno, ThemeInfo } from '@eve-cyno/plugin-api';

const eveCyno = (globalThis as unknown as { eveCyno: EveCyno }).eveCyno;

const status = document.getElementById('status') as HTMLElement;
let greetings = 0;

/** Paints the host theme: the page has no CSS from the host, so it reads the colours and sets its own variables. */
function applyTheme(theme: ThemeInfo): void {
  const root = document.documentElement.style;
  root.setProperty('--bg', theme.colors.background);
  root.setProperty('--surface', theme.colors.surface);
  root.setProperty('--text', theme.colors.text);
  root.setProperty('--muted', theme.colors.textMuted);
  root.setProperty('--line', theme.colors.line);
  root.setProperty('--own', theme.colors.own);
  root.setProperty('--radius', `${theme.radius}px`);
}

async function sayHello(): Promise<void> {
  greetings += 1;
  status.textContent = `Hello from the plugin (${greetings})`;
  await eveCyno.tile.setSummary({ title: 'Hello', lines: [`Greetings: ${greetings}`] });
}

async function main(): Promise<void> {
  applyTheme(await eveCyno.theme.get());
  eveCyno.theme.onChanged(applyTheme);
  // The tile button and the command palette both run the command declared in plugin.json.
  eveCyno.commands.onCommand(command => {
    if (command.id === 'say-hello') void sayHello();
  });
  document.getElementById('hello')?.addEventListener('click', () => void sayHello());
  await eveCyno.tile.setSummary({ title: 'Hello', lines: ['Ready'] });
}

void main();

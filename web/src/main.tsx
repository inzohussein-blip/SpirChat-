import { render } from 'preact';
import { App } from './app.tsx';
import { applyDir } from './lib/i18n.ts';
import { app } from './lib/state.ts';
import './styles.css';

applyDir();
app.load().then(
  () => render(<App />, document.getElementById('app')!),
  (e: unknown) => {
    document.getElementById('app')!.textContent = `Failed to start: ${(e as Error).message}`;
  },
);

import { createRoot } from 'react-dom/client';
import '@radix-ui/themes/styles.css';
import './styles.css';
import { AppProvider } from './core';
import App from './App';

const container = document.getElementById('hej-settings-root');
if (!container) {
  throw new Error('Hejhome settings root is missing.');
}

createRoot(container).render(
  <AppProvider><App /></AppProvider>,
);

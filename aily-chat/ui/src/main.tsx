import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './icons/setup';
import './styles.css';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

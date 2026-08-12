import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// BlockNote maakt bij elk document (elke useCreateBlockNote-aanroep) een
// nieuwe editor-instantie aan, die telkens opnieuw linkifyjs' 'http'-scheme
// probeert te registreren. linkifyjs staat dat na de allereerste keer
// bewust niet meer toe (module-brede eenmalige init) en logt dan deze
// waarschuwing — volledig onschadelijk (links blijven gewoon werken), maar
// spamt de console bij elk document dat je opent. Gericht wegfilteren,
// zonder andere console.warn-meldingen te verbergen.
const originalWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('linkifyjs: already initialized')) return;
  originalWarn(...args);
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

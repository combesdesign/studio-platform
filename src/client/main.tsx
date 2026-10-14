// PLACEHOLDER — replaced by the client app agent.
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import { DemoBadge, ToastProvider } from '../shared/react';
createRoot(document.getElementById('root')!).render(<ToastProvider><DemoBadge /><h1 style={{padding:24}}>client app</h1></ToastProvider>);

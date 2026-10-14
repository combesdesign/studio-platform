// PLACEHOLDER — replaced by the studio app agent.
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import { DemoBadge, ToastProvider } from '../shared/react';
createRoot(document.getElementById('root')!).render(<ToastProvider><DemoBadge /><h1 style={{padding:24}}>studio app</h1></ToastProvider>);

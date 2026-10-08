import { createRoot } from 'react-dom/client';
import { PresenceCounter } from '../../../src/client/footer';

const root = createRoot(document.getElementById('presence-fixture')!);
root.render(<PresenceCounter />);
document.getElementById('remove-presence')!.addEventListener('click', () => root.unmount());

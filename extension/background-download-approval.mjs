const commandId = new URL(location.href).searchParams.get('command');
const status = document.querySelector('#status');
const approve = document.querySelector('#approve');
const reject = document.querySelector('#reject');
const message = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
try {
  const current = await message('HERMES_CONTROLLER_STATUS');
  const request = current?.pendingApproval;
  if (!request || request.commandId !== commandId || !request.controllerId?.startsWith('background-')) {
    status.textContent = 'No hay una descarga pendiente. Puede que la solicitud haya caducado.';
  } else {
    status.textContent = 'Hermes solicita descargar los archivos seleccionados en Google Drive.';
    approve.disabled = reject.disabled = false;
    const decide = async (accept) => {
      approve.disabled = reject.disabled = true;
      try {
        const result = await message(accept ? 'HERMES_CONTROLLER_APPROVAL_GRANT' : 'HERMES_CONTROLLER_APPROVAL_REJECT', request);
        if (!result?.ok) {
          status.textContent = `No se autorizó la descarga (${result?.error || 'solicitud no disponible'}).`;
          return;
        }
        window.close();
      } catch {
        status.textContent = 'No se pudo enviar la decisión a Hermes.';
      }
    };
    approve.addEventListener('click', () => void decide(true), { once: true });
    reject.addEventListener('click', () => void decide(false), { once: true });
  }
} catch {
  status.textContent = 'No se pudo consultar la solicitud de Hermes.';
}

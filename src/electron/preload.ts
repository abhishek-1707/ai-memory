import { contextBridge, ipcRenderer } from 'electron';

const OWNER_BOOTSTRAP_CHANNEL = 'omnimemory:create-owner';

contextBridge.exposeInMainWorld('omnimemoryDesktop', {
  createOwner(input: {
    readonly password: string;
    readonly deviceName: string;
    readonly deviceType: string;
  }) {
    return ipcRenderer.invoke(OWNER_BOOTSTRAP_CHANNEL, input);
  },
});

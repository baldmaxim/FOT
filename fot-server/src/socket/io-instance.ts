import type { Server } from 'socket.io';

let _io: Server | null = null;

export const setIo = (io: Server): void => {
  _io = io;
};

export const getIo = (): Server | null => _io;

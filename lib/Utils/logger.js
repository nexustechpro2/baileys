import P from 'pino';
export const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` });
export default logger;
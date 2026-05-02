"use strict";
import gradient from 'gradient-string';
import makeWASocket from './Socket/index.js';
import NexusHandler from './Socket/nexus-handler.js';
const banner = `
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗                    ║
║   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝                    ║
║   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗                    ║
║   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║                    ║
║   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║                    ║
║   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝                    ║
║                                                                  ║
║        ████████╗███████╗ ██████╗██╗  ██╗                         ║
║        ╚══██╔══╝██╔════╝██╔════╝██║  ██║                         ║
║           ██║   █████╗  ██║     ███████║                         ║
║           ██║   ██╔══╝  ██║     ██╔══██║                         ║
║           ██║   ███████╗╚██████╗██║  ██║                         ║
║           ╚═╝   ╚══════╝ ╚═════╝╚═╝  ╚═╝                         ║
║                                                                  ║
║              ██████╗ ██████╗  ██████╗                            ║
║              ██╔══██╗██╔══██╗██╔═══██╗                           ║
║              ██████╔╝██████╔╝██║   ██║                           ║
║              ██╔═══╝ ██╔══██╗██║   ██║                           ║
║              ██║     ██║  ██║╚██████╔╝                           ║
║              ╚═╝     ╚═╝  ╚═╝ ╚═════╝                            ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`;

const info = `
┌───────────────────────────────────────────────────────────────────────┐
│  📦 Package: @nexustechpro/baileys                                   │
│  🔖 Version: 2.0.4                                                   │
│  ⚡ Status:  Production Ready                                        │
├───────────────────────────────────────────────────────────────────────┤
│  🚀 Advanced WhatsApp Web API Client                                  │
│  ✨ Interactive Buttons • Products • Events • Media                   │
│  🔐 End-to-End Encryption • Multi-Device Support                      │
│  📱 Business API • Channels • Status Updates                          │
├───────────────────────────────────────────────────────────────────────┤
│  💡 Built by NexusTech Pro Team                                       │
│  📚 Docs: github.com/nexustechpro2/baileys                             │
│  💬 Support: Join our community for updates & assistance              │
└───────────────────────────────────────────────────────────────────────┘
`;

// Print banner with gradient
console.log(gradient(['#00D4FF', '#0099FF', '#00D4FF'])(banner));

// Print info with gradient
console.log(gradient(['#FFD700', '#FF6B6B', '#4ECDC4'])(info));

// Startup message
console.log(gradient(['#00FF88', '#FFFFFF'])('\n🎯 Initializing Baileys Socket Connection...\n'));

export * from '../WAProto/index.js';
export * from './Utils/index.js';
export * from './Store/index.js';
export * from './Types/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
export { NexusHandler, makeWASocket };
export default makeWASocket;
import gradient from 'gradient-string'
import makeWASocket from './Socket/index.js'

const banner = [
    '╭───────────────────────────────────────────────────────────────────────────────────────────╮',
    '│                                                                                           │',
    '│  [][][][][] [][][][][] [][][][]   []      []   [][][]   []      [] [][][][][] []      []  │',
    '│        []   []         []      [] []      [] []      [] [][]    [] []           []  []    │',
    '│      []     []         []      [] []      [] []      [] []  []  [] []           []  []    │',
    '│    []       [][][][]   [][][][]     []  []   []      [] []  []  [] [][][][]       []      │',
    '│  []         []         []  []       []  []   []      [] []    [][] []           []  []    │',
    '│  []         []         []    []       []     []      [] []      [] []           []  []    │',
    '│  [][][][][] [][][][][] []      []     []       [][][]   []      [] [][][][][] []      []  │',
    '│                                                                                           │',
    '├───────────────────────────────────────────────────────────────────────────────────────────┤',
    '│                                                                                           │',
    '│       [][][][]     [][][]   [][][][][] []         [][][][][] []      []   [][][][]        │',
    '│       []      [] []      []     []     []         []         []      [] []                │',
    '│       []      [] []      []     []     []         []           []  []   []                │',
    '│       [][][][]   [][][][][]     []     []         [][][][]       []       [][][]          │',
    '│       []      [] []      []     []     []         []             []             []        │',
    '│       []      [] []      []     []     []         []             []             []        │',
    '│       [][][][]   []      [] [][][][][] [][][][][] [][][][][]     []     [][][][]          │',
    '│                                                                                           │',
    '╰───────────────────────────────────────────────────────────────────────────────────────────╯',
].join('\n')

const info = [
    '╭──────────────────────────────────────────────────────────────╮',
    '│                                                              │',
    '│  ◆  Package  ›  @zervonex/baileys                            │',
    '│  ◆  Version  ›  3.0.8                                        │',
    '│  ◆  Status   ›  Production Ready                             │',
    '│                                                              │',
    '├──────────────────────────── ◇◆◇ ─────────────────────────────┤',
    '│                                                              │',
    '│  ✦  WhatsApp Web API Client                                  │',
    '│  ✦  Interactive Buttons  ·  Products  ·  Events  ·  Media    │',
    '│  ✦  End-to-End Encryption  ·  Multi-Device Support           │',
    '│  ✦  Business API  ·  Channels  ·  Status Updates             │',
    '│                                                              │',
    '├──────────────────────────── ◇◆◇ ─────────────────────────────┤',
    '│                                                              │',
    '│  ◈  Built by   ›  zervonex Team                              │',
    '│  ◈  Formerly   ›  @nexustechpro/baileys                      │',
    '│  ◈  Docs       ›  github.com/nexustechpro2/baileys           │',
    '│  ◈  Support    ›  Join our community for updates             │',
    '│                                                              │',
    '╰──────────────────────────────────────────────────────────────╯',
].join('\n')

console.log(gradient(['#00FFFF', '#00BFFF', '#7B2FBE', '#FF6EC7', '#00FFFF'])(banner))
console.log(gradient(['#FFD700', '#FFA500', '#FF6EC7', '#FFD700'])(info))
console.log(gradient(['#00FF88', '#FFFFFF'])('\n🎯 Initializing Baileys Socket Connection...\n'))

export * from '../WAProto/index.js'
export * from './Utils/index.js'
export * from './Store/index.js'
export * from './Types/index.js'
export * from './Defaults/index.js'
export * from './WABinary/index.js'
export * from './WAM/index.js'
export * from './WAUSync/index.js'
export * from './Socket/index.js'
export * from './Builders/index.js'
export { makeWASocket }
export default makeWASocket
// Compatibility shim.
//
// Emscripten 5.x no longer emits a separate <name>.worker.js. The pthread
// worker code is inlined into pikafish.js, which self-references as the
// Worker script. This file exists only so that extension registrations that
// list all four files (pikafish.{js,wasm,worker.js,nnue}) don't 404.
//
// At runtime, pikafish.js creates workers by passing its own URL to `new
// Worker(...)`, so this shim is never loaded as the worker script itself.
// If you *need* the Worker to load a distinct file, set
// `Module.mainScriptUrlOrBlob = 'pikafish.js'` before calling Pikafish(...).
importScripts('pikafish.js');

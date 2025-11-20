export class EventEmitter {
    private events: { [key: string]: Function[] } = {};
  
    on(event: string, handler: Function) {
      if (!this.events[event]) {
        this.events[event] = [];
      }
      this.events[event].push(handler);
    }
  
    emit(event: string, ...args: any[]) {
      const handlers = this.events[event];
      if (!handlers) return;
      handlers.forEach(fn => fn(...args));
    }
  }
  
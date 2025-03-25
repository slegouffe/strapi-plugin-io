export default {
  default: {
    events: [],
    hooks: {},
    socket: {
      serverOptions: { 
        cors: { 
          origin: 'http://localhost:8100', 
          methods: ['GET', 'POST'] 
        } 
      },
    },
  },
  validator() {},
};

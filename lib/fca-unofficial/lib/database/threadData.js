module.exports = function (bot) {
  return {
    async create(threadID, data) {
      return { thread: {}, created: true };
    },
    async get(threadID) {
      return null;
    },
    async update(threadID, data) {
      return { thread: {}, created: false };
    },
    async del(threadID) {
      return 1;
    },
    async delAll() {
      return 1;
    },
    async getAll(keys = null) {
      return [];
    },
  };
};
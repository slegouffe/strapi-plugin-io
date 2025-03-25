import { Server } from "socket.io";
import { pipe, castArray, every, isNil as isNil$1 } from "lodash/fp";
import { differenceInHours, parseISO } from "date-fns";
const pluginPkg = require("../../package.json");
const pluginId = pluginPkg.strapi.name;
const getService = ({ name, plugin = pluginId, type = "plugin" }) => {
  let serviceUID = `${type}::${plugin}`;
  if (name && name.length) {
    serviceUID += `.${name}`;
  }
  console.log("serviceUID", serviceUID);
  return strapi.service(serviceUID);
};
const handshake = async (socket, next) => {
  const strategyService = getService({ name: "strategies" });
  const auth = socket.handshake.auth || {};
  let strategy = auth.strategy || "jwt";
  const token = auth.token || "";
  if (!token.length) {
    strategy = "";
  }
  try {
    let room;
    if (strategy && strategy.length) {
      const strategyType = strategy === "jwt" ? "role" : "token";
      const ctx = await strategyService[strategyType].authenticate(auth);
      room = strategyService[strategyType].getRoomName(ctx);
    } else if (strapi.plugin("users-permissions")) {
      const role = await strapi.query("plugin::users-permissions.role").findOne({ where: { type: "public" }, select: ["id", "name"] });
      room = strategyService["role"].getRoomName(role);
    }
    if (room) {
      socket.join(room.replace(" ", "-"));
    } else {
      throw new Error("No valid room found");
    }
    next();
  } catch (error) {
    next(new Error(error.message));
  }
};
const API_TOKEN_TYPE = {
  READ_ONLY: "read-only",
  FULL_ACCESS: "full-access",
  CUSTOM: "custom"
};
class SocketIO {
  constructor(options) {
    this._socket = new Server(strapi.server.httpServer, options);
    const { hooks } = strapi.config.get(`plugin::${pluginId}`);
    hooks.init?.({ strapi, $io: this });
    this._socket.use(handshake);
  }
  // eslint-disable-next-line no-unused-vars
  async emit({ event, schema, data: rawData }) {
    const sanitizeService = getService({ name: "sanitize" });
    const strategyService = getService({ name: "strategy" });
    const transformService = getService({ name: "transform" });
    if (!rawData) {
      return;
    }
    const eventName = `${schema.singularName}:${event}`;
    for (const strategyType in strategyService) {
      if (Object.hasOwnProperty.call(strategyService, strategyType)) {
        const strategy = strategyService[strategyType];
        const rooms = await strategy.getRooms();
        for (const room of rooms) {
          const permissions = room.permissions.map(({ action }) => ({ action }));
          const ability = await strapi.contentAPI.permissions.engine.generateAbility(permissions);
          if (room.type === API_TOKEN_TYPE.FULL_ACCESS || ability.can(schema.uid + "." + event)) {
            const sanitizedData = await sanitizeService.output({
              data: rawData,
              schema,
              options: {
                auth: {
                  name: strategy.name,
                  ability,
                  strategy: {
                    verify: strategy.verify
                  },
                  credentials: strategy.credentials?.(room)
                }
              }
            });
            const roomName = strategy.getRoomName(room);
            const data = transformService.response({ data: sanitizedData, schema });
            this._socket.to(roomName.replace(" ", "-")).emit(eventName, { ...data });
          }
        }
      }
    }
  }
  async raw({ event, data, rooms }) {
    let emitter = this._socket;
    if (rooms && rooms.length) {
      rooms.forEach((r) => {
        emitter = emitter.to(r);
      });
    }
    emitter.emit(event, { data });
  }
  get server() {
    return this._socket;
  }
}
const bootstrapIO = async ({ strapi: strapi2 }) => {
  const settings = strapi2.config.get(`plugin::${pluginId}`);
  const io = new SocketIO(settings.socket.serverOptions);
  strapi2.$io = io;
  if (settings.events?.length) {
    strapi2.$io.server.on("connection", (socket) => {
      for (const event of settings.events) {
        if (event.name === "connection") {
          event.handler({ strapi: strapi2, io }, socket);
        } else {
          socket.on(event.name, (...args) => event.handler({ strapi: strapi2, io }, socket, ...args));
        }
      }
    });
  }
};
const bootstrapLifecycles = async ({ strapi: strapi2 }) => {
  strapi2.config.get(`plugin::${pluginId}.contentTypes`, []).forEach((ct) => {
    const uid = ct.uid ? ct.uid : ct;
    const subscriber = {
      models: [uid]
    };
    if (!ct.actions || ct.actions.includes("create")) {
      const eventType = "create";
      subscriber.afterCreate = async (event) => {
        strapi2.$io.emit({
          event: eventType,
          schema: event.model,
          data: event.result
        });
      };
      subscriber.afterCreateMany = async (event) => {
        const query = buildEventQuery({ event });
        if (query.filters) {
          const records = await strapi2.entityService.findMany(uid, query);
          records.forEach((r) => {
            strapi2.$io.emit({
              event: eventType,
              schema: event.model,
              data: r
            });
          });
        }
      };
    }
    if (!ct.actions || ct.actions.includes("update")) {
      const eventType = "update";
      subscriber.afterUpdate = async (event) => {
        strapi2.$io.emit({
          event: eventType,
          schema: event.model,
          data: event.result
        });
      };
      subscriber.beforeUpdateMany = async (event) => {
        const query = buildEventQuery({ event });
        if (query.filters) {
          const ids = await strapi2.entityService.findMany(uid, query);
          if (!event.state.io) {
            event.state.io = {};
          }
          event.state.io.ids = ids;
        }
      };
      subscriber.afterUpdateMany = async (event) => {
        if (!event.state.io?.ids) {
          return;
        }
        const records = await strapi2.entityService.findMany(uid, {
          filters: { id: event.state.io.ids }
        });
        records.forEach((r) => {
          strapi2.$io.emit({
            event: eventType,
            schema: event.model,
            data: r
          });
        });
      };
    }
    if (!ct.actions || ct.actions.includes("delete")) {
      const eventType = "delete";
      subscriber.afterDelete = async (event) => {
        strapi2.$io.emit({
          event: eventType,
          schema: event.model,
          data: event.result
        });
      };
      subscriber.beforeDeleteMany = async (event) => {
        const query = buildEventQuery({ event });
        if (query.filters) {
          const records = await strapi2.entityService.findMany(uid, query);
          if (!event.state.io) {
            event.state.io = {};
          }
          event.state.io.records = records;
        }
      };
      subscriber.afterDeleteMany = async (event) => {
        if (!event.state.io?.records) {
          return;
        }
        event.state.io.records.forEach((r) => {
          strapi2.$io.emit({
            event: eventType,
            schema: event.model,
            data: r
          });
        });
      };
    }
    strapi2.db.lifecycles.subscribe(subscriber);
  });
};
function buildEventQuery({ event }) {
  const query = {};
  if (event.params.where) {
    query.filters = event.params.where;
  }
  if (event.result?.count) {
    query.limit = event.result.count;
  } else if (event.params.limit) {
    query.limit = event.params.limit;
  }
  if (event.action === "afterCreateMany") {
    query.filters = { id: event.result.ids };
  } else if (event.action === "beforeUpdate") {
    query.fields = ["id"];
  }
  return query;
}
const bootstrap = ({ strapi: strapi2 }) => {
  console.log("\n IO Bootstrap !");
  bootstrapIO({ strapi: strapi2 });
  bootstrapLifecycles({ strapi: strapi2 });
};
const destroy = ({ strapi: strapi2 }) => {
};
const register = ({ strapi: strapi2 }) => {
};
const config = {
  default: {
    events: [],
    hooks: {},
    socket: {
      serverOptions: {
        cors: {
          origin: "http://localhost:8100",
          methods: ["GET", "POST"]
        }
      }
    }
  },
  validator() {
  }
};
const contentTypes = {};
const controller = ({ strapi: strapi2 }) => ({
  index(ctx) {
    ctx.body = strapi2.plugin("strapi-plugin-io").service("service").getWelcomeMessage();
  }
});
const controllers = {
  controller
};
const policies = {};
const contentAPIRoutes = [
  {
    method: "GET",
    path: "/",
    // name of the controller file & the method.
    handler: "controller.index",
    config: {
      policies: []
    }
  }
];
const routes = {
  "content-api": {
    type: "content-api",
    routes: contentAPIRoutes
  }
};
const { sanitize } = require("@strapi/utils");
const sanitize$1 = ({ strapi: strapi2 }) => {
  function output({ schema, data, options }) {
    return sanitize.contentAPI.output(data, schema, options);
  }
  return {
    output
  };
};
const { UnauthorizedError, ForbiddenError } = require("@strapi/utils").errors;
const strategies = ({ strapi: strapi2 }) => {
  const apiTokenService = getService({ type: "admin", plugin: "api-token" });
  const jwtService = getService({ name: "jwt", plugin: "users-permissions" });
  const userService = getService({ name: "user", plugin: "users-permissions" });
  const role = {
    name: "io-role",
    credentials: function(role2) {
      return `${this.name}-${role2.id}`;
    },
    authenticate: async function(auth) {
      const token2 = await jwtService.verify(auth.token);
      if (!token2) {
        throw new UnauthorizedError("Invalid credentials");
      }
      const { id } = token2;
      if (id === void 0) {
        throw new UnauthorizedError("Invalid credentials");
      }
      const user = await userService.fetchAuthenticatedUser(id);
      if (!user) {
        throw new UnauthorizedError("Invalid credentials");
      }
      const advancedSettings = await strapi2.store({ type: "plugin", name: "users-permissions" }).get({ key: "advanced" });
      if (advancedSettings.email_confirmation && !user.confirmed) {
        throw new UnauthorizedError("Invalid credentials");
      }
      if (user.blocked) {
        throw new UnauthorizedError("Invalid credentials");
      }
      return strapi2.entityService.findOne("plugin::users-permissions.role", user.role.id, {
        fields: ["id", "name"]
      });
    },
    verify: function(auth, config2) {
      const { ability } = auth;
      if (!ability) {
        throw new UnauthorizedError();
      }
      const isAllowed = pipe(
        castArray,
        every((scope) => ability.can(scope))
      )(config2.scope);
      if (!isAllowed) {
        throw new ForbiddenError();
      }
    },
    getRoomName: function(role2) {
      console.log("role", role2);
      return `${this.name}-${role2.name.toLowerCase()}`;
    },
    getRooms: function() {
      return strapi2.entityService.findMany("plugin::users-permissions.role", {
        fields: ["id", "name"],
        populate: { permissions: true }
      });
    }
  };
  const token = {
    name: "io-token",
    credentials: function(token2) {
      return token2;
    },
    authenticate: async function(auth) {
      const token2 = auth.token;
      if (!token2) {
        throw new UnauthorizedError("Invalid credentials");
      }
      const apiToken = await strapi2.query("admin::api-token").findOne({
        where: { accessKey: apiTokenService.hash(token2) },
        select: ["id", "name", "type", "lastUsedAt", "expiresAt"],
        populate: ["permissions"]
      });
      if (!apiToken) {
        throw new UnauthorizedError("Invalid credentials");
      }
      const currentDate = /* @__PURE__ */ new Date();
      if (!isNil$1(apiToken.expiresAt)) {
        const expirationDate = new Date(apiToken.expiresAt);
        if (expirationDate < currentDate) {
          throw new UnauthorizedError("Token expired");
        }
      }
      if (!apiToken.lastUsedAt || differenceInHours(currentDate, parseISO(apiToken.lastUsedAt)) >= 1) {
        await strapi2.query("admin::api-token").update({
          where: { id: apiToken.id },
          data: { lastUsedAt: currentDate }
        });
      }
      return apiToken;
    },
    verify: function(auth, config2) {
      const { credentials: apiToken, ability } = auth;
      if (!apiToken) {
        throw new UnauthorizedError("Token not found");
      }
      if (!isNil$1(apiToken.expiresAt)) {
        const currentDate = /* @__PURE__ */ new Date();
        const expirationDate = new Date(apiToken.expiresAt);
        if (expirationDate < currentDate) {
          throw new UnauthorizedError("Token expired");
        }
      }
      if (apiToken.type === API_TOKEN_TYPE.FULL_ACCESS) {
        return;
      } else if (apiToken.type === API_TOKEN_TYPE.READ_ONLY) {
        const scopes = castArray(config2.scope);
        if (config2.scope && scopes.every(isReadScope)) {
          return;
        }
      } else if (apiToken.type === API_TOKEN_TYPE.CUSTOM) {
        if (!ability) {
          throw new ForbiddenError();
        }
        const scopes = castArray(config2.scope);
        const isAllowed = scopes.every((scope) => ability.can(scope));
        if (isAllowed) {
          return;
        }
      }
      throw new ForbiddenError();
    },
    getRoomName: function(token2) {
      return `${this.name}-${token2.name.toLowerCase()}`;
    },
    getRooms: function() {
      return strapi2.entityService.findMany("admin::api-token", {
        fields: ["id", "type", "name"],
        filters: {
          $or: [
            {
              expiresAt: {
                $gte: /* @__PURE__ */ new Date()
              }
            },
            {
              expiresAt: null
            }
          ]
        },
        populate: { permissions: true }
      });
    }
  };
  return {
    role,
    token
  };
};
const { isNil, isPlainObject } = require("lodash/fp");
const transform = ({ strapi: strapi2 }) => {
  function response({ data, schema }) {
    return transformResponse(data, {}, { contentType: schema });
  }
  return {
    response
  };
};
function isEntry(property) {
  return property === null || isPlainObject(property) || Array.isArray(property);
}
function isDZEntries(property) {
  return Array.isArray(property);
}
function transformResponse(resource, meta = {}, opts = {}) {
  if (isNil(resource)) {
    return resource;
  }
  return {
    data: transformEntry(resource, opts?.contentType),
    meta
  };
}
function transformComponent(data, component) {
  if (Array.isArray(data)) {
    return data.map((datum) => transformComponent(datum, component));
  }
  const res = transformEntry(data, component);
  if (isNil(res)) {
    return res;
  }
  const { id, attributes } = res;
  return { id, ...attributes };
}
function transformEntry(entry, type) {
  if (isNil(entry)) {
    return entry;
  }
  if (Array.isArray(entry)) {
    return entry.map((singleEntry) => transformEntry(singleEntry, type));
  }
  if (!isPlainObject(entry)) {
    throw new Error("Entry must be an object");
  }
  const { id, ...properties } = entry;
  const attributeValues = {};
  for (const key of Object.keys(properties)) {
    const property = properties[key];
    const attribute = type && type.attributes[key];
    if (attribute && attribute.type === "relation" && isEntry(property) && "target" in attribute) {
      const data = transformEntry(property, strapi.contentType(attribute.target));
      attributeValues[key] = { data };
    } else if (attribute && attribute.type === "component" && isEntry(property)) {
      attributeValues[key] = transformComponent(property, strapi.components[attribute.component]);
    } else if (attribute && attribute.type === "dynamiczone" && isDZEntries(property)) {
      if (isNil(property)) {
        attributeValues[key] = property;
      }
      attributeValues[key] = property.map((subProperty) => {
        return transformComponent(subProperty, strapi.components[subProperty.__component]);
      });
    } else if (attribute && attribute.type === "media" && isEntry(property)) {
      const data = transformEntry(property, strapi.contentType("plugin::upload.file"));
      attributeValues[key] = { data };
    } else {
      attributeValues[key] = property;
    }
  }
  return {
    id,
    attributes: attributeValues
    // NOTE: not necessary for now
    // meta: {},
  };
}
const services = {
  sanitize: sanitize$1,
  strategies,
  transform
};
const index = {
  bootstrap,
  destroy,
  register,
  config,
  controllers,
  contentTypes,
  middlewares: handshake,
  policies,
  routes,
  services
};
export {
  index as default
};
//# sourceMappingURL=index.mjs.map

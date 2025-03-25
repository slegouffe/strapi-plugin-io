'use strict';

import { SocketIO } from '../structures';
import { pluginId } from '../utils/pluginId';

/**
 * Bootstrap IO instance and related "services"
 *
 * @param {*} params
 * @param {*} params.strapi
 */
export const bootstrapIO = async ({ strapi }) => {
	const settings = strapi.config.get(`plugin::${pluginId}`);

  // initialize io
	const io = new SocketIO(settings.socket.serverOptions);

	// // make io avaiable anywhere strapi global object is
	strapi.$io = io;

  // add any io server events
	if (settings.events?.length) {
		strapi.$io.server.on('connection', (socket) => {
			for (const event of settings.events) {
				// "connection" event should be executed immediately
				if (event.name === 'connection') {
					event.handler({ strapi, io }, socket);
				} else {
					// register all other events to be triggered at a later time
					socket.on(event.name, (...args) => event.handler({ strapi, io }, socket, ...args));
				}
			}
		});
	}
}

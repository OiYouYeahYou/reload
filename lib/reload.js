// Requires
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const ws = require('ws')

module.exports = function reload(app, opts, server) {
	opts = opts || {}

	var argumentCache = arguments

	// Parameters variables
	const port = opts.port || 9856
	const httpsOption = opts.https || null
	const httpServerOrPort = server || port
	const forceWss = opts.forceWss || false
	const verboseLogging = opts.verbose || false
	const webSocketServerWaitStart = opts.webSocketServerWaitStart || false

	// Application variables
	const RELOAD_FILE = path.join(__dirname, './reload-client.js')
	let reloadCode = fs.readFileSync(RELOAD_FILE, 'utf8')
	const route = opts.route ? processRoute(opts.route) : '/reload/reload.js'

	// Websocket server variables
	let wss

	// General variables
	const socketPortSpecified = server ? null : port
	const connections = {}
	let httpOrHttpsServer

	if (argumentCache[0] === undefined) {
		return Promise.reject(new Error('Lack of/invalid arguments provided to reload'))
	} else if (
		typeof (argumentCache[0]) !== 'function'
		&& (
			typeof (argumentCache[1]) !== 'object'
			|| typeof (argumentCache[1]) !== 'undefined'
		)
	) {
		return Promise.reject(new Error('Lack of/invalid arguments provided to reload'))
	} else if (typeof port !== 'number') {
		return Promise.reject(new Error('Specified port is not of type number'))
	} else if (typeof forceWss !== 'boolean') {
		return Promise.reject(new Error('forceWss option specified is not of type boolean'))
	} else if (typeof verboseLogging !== 'boolean') {
		return Promise.reject(new Error('verboseLogging option specified is not of type boolean'))
	} else if (typeof webSocketServerWaitStart !== 'boolean') {
		return Promise.reject(new Error('webSocketServerWaitStart option specified is not of type boolean'))
	}

	// Application setup
	setupClientSideCode()

	return setupExpressAppRouting().then(function () {
		if (!webSocketServerWaitStart) {
			return startWebSocketServer()
		} else {
			return (getReloadReturn())
		}
	})

	function setupExpressAppRouting() {
		if (server !== undefined) {
			return Promise.resolve()
		} else if (!app.get) {
			return Promise.reject(new Error('Could not attach route to express app. Be sure that app passed is actually an express app'))
		}

		app.get(route, function (req, res) {
			res.type('text/javascript')
			res.send(reloadCode)
		})
		return Promise.resolve()
	}

	function setupClientSideCode() {
		if (verboseLogging) {
			reloadCode = reloadCode.replace(
				'verboseLogging = false',
				'verboseLogging = true'
			)
		}

		const webSocketString = forceWss ? 'wss://$3' : 'ws$2://$3'

		reloadCode = reloadCode.replace(
			'socketUrl.replace()',
			'socketUrl.replace(/(^http(s?):\\/\\/)(.*:)(.*)/,'
			+ (
				socketPortSpecified
					? '\'' + webSocketString + socketPortSpecified
					: '\'' + webSocketString + '$4'
			)
			+ '\')'
		)
	}

	// Websocket server setup
	function startWebSocketServer() {
		const WebSocketServer = ws.Server

		return new Promise(function (resolve, reject) {
			if (verboseLogging) {
				console.log('Starting WebSocket Server')
			}

			if (socketPortSpecified) { // Use custom user specified port
				wss = new WebSocketServer({ noServer: true })

				if (httpsOption) { // HTTPS
					const httpsOptions = createHttpsOptions(httpsOption)
					httpOrHttpsServer = https.createServer(httpsOptions)
				} else { // HTTP
					httpOrHttpsServer = http.createServer()
				}

				httpOrHttpsServer.listen(port, function () {
					resolve(getReloadReturn())
				})

				httpOrHttpsServer.on('upgrade', (request, socket, head) => {
					wss.handleUpgrade(request, socket, head, (ws) => {
						wss.emit('connection', ws, request)
					})
				})

				// Keep track of connections so we can force shutdown the server
				// https://stackoverflow.com/questions/14626636/how-do-i-shutdown-a-node-js-https-server-immediately/14636625#14636625
				httpOrHttpsServer.on('connection', mapConnections)
			} else { // Attach to server, using server's port. Kept here to support legacy arguments.
				wss = new WebSocketServer({ server: httpServerOrPort })
				resolve(getReloadReturn())
			}

			wss.on('connection', (ws) => {
				if (verboseLogging) {
					console.log('Reload client connected to server')
				}
			})
		})
	}

	function sendMessage(message) {
		if (verboseLogging) {
			console.log(
				'Sending message to '
				+ wss.clients.size
				+ ' connection(s): '
				+ message
			)
		}

		wss.clients.forEach(function each(client) {
			/* istanbul ignore else */
			if (client.readyState === ws.OPEN) {
				client.send(message)
			}
		})
	}

	// assign individual keys to connections when opened so they can be destroyed gracefully
	function mapConnections(conn) {
		const key = conn.remoteAddress + ':' + conn.remotePort
		connections[key] = conn

		// once the connection closes, remove
		conn.on('close', function () {
			delete connections[key]
		})
	}

	function processRoute(route) {
		// If reload.js is found in the route option strip it. We will concat it for user to ensure no case errors or order problems.
		const reloadJsMatch = route.match(/reload\.js/i)
		if (reloadJsMatch) {
			route = route.split(reloadJsMatch)[0]
		}

		/*
			* Concat their provided path (minus `reload.js` if they specified it) with a `/` if they didn't provide one and `reload.js. This allows for us to ensure case, order, and use of `/` is correct
			* For example these route's are all valid:
			* 1. `newRoutePath` -> Their route + `/` + reload.js
			* 2. `newRoutePath/` -> Their route + reload.js
			* 3. `newRoutePath/reload.js` -> (Strip reload.js above) so now: Their route + reload.js
			* 4. `newRoutePath/rEload.js` -> (Strip reload.js above) so now: Their route + reload.js
			* 5. `newRoutePathreload.js` -> (Strip reload.js above) so now: Their route + `/` + reload.js
			* 6. `newRoutePath/reload.js/rEload.js/... reload.js n number of times -> (Strip above removes all reload.js occurrences at the end of the specified route) so now: Their route + 'reload.js`
		*/
		return route + (route.slice(-1) === '/' ? '' : '/') + 'reload.js'
	}

	function getReloadReturn() {
		const tempObject = {
			reload: function () {
				sendMessage('reload')
			},
			wss: wss,
			closeServer: function () {
				return new Promise(function (resolve, reject) {
					// Loop through all connections and terminate them for immediate server shutdown
					for (const key in connections) {
						connections[key].destroy()
					}
					httpOrHttpsServer.close(resolve)
				})
			}
		}

		// Only define the function and make it available if the WebSocket is waiting in the first place
		if (webSocketServerWaitStart) {
			tempObject.startWebSocketServer = startWebSocketServer
		}

		if (server) { // Private return API only used in command line version of reload
			tempObject.reloadClientCode = function () {
				return reloadCode
			}
		}

		return tempObject
	}
}

function createHttpsOptions(httpsOption) {
	const httpsOptions = {}
	const { p12, certAndKey } = httpsOption

	if (p12) {
		const { p12Path, passphrase } = p12

		if (typeof p12Path === 'string' && p12Path.match(/\.\w{3}$/)) {
			httpsOptions.pfx = fs.readFileSync(p12Path)
		} else {
			httpsOptions.pfx = p12Path
		}

		/* istanbul ignore else */
		if (passphrase) {
			httpsOptions.passphrase = passphrase
		}
	} else if (certAndKey) {
		const { key, cert } = certAndKey

		/* istanbul ignore else */
		if (key) {
			if (isCertString(key)) {
				httpsOptions.key = key
			} else {
				httpsOptions.key = fs.readFileSync(key)
			}
		}

		/* istanbul ignore else */
		if (cert) {
			if (isCertString(cert)) {
				httpsOptions.cert = cert
			} else {
				httpsOptions.cert = fs.readFileSync(cert)
			}
		}
	} else {
		throw new Error('Could not initialize reload HTTPS setup incorrectly. Make sure to define a `p12` or `certAndKey` in the HTTPS options')
	}

	return httpsOptions
}

function isCertString(stringToTest) {
	let testString = stringToTest
	if (typeof testString !== 'string') {
		testString = testString.toString()
	}
	const lastChar = testString.substring(testString.length - 1)
	// A file path string won't have an end of line character at the end
	// Looking for either \n or \r allows for nearly any OS someone could
	// use, and a few that node doesn't work on.
	return lastChar === '\n' || lastChar === '\r'
}

import { DurableObject } from "cloudflare:workers";

// Worker
export default {
	async fetch(request, env, ctx) {
		if (request.url.endsWith("/dave")||request.url.endsWith("/chris")||request.url.endsWith("/andy")||request.url.endsWith("/nick")) {
			// Expect to receive a WebSocket Upgrade request.
			// If there is one, accept the request and return a WebSocket Response.
			const upgradeHeader = request.headers.get("Upgrade");
			if (!upgradeHeader || upgradeHeader !== "websocket") {
				return new Response("Worker expected Upgrade: websocket", {
					status: 426,
				});
			}

			if (request.method !== "GET") {
				return new Response("Worker expected GET method", {
					status: 400,
				});
			}

			// Since we are hard coding the Durable Object ID by providing the constant name 'turbo',
			// all requests to this Worker will be sent to the same Durable Object instance.
			let id = env.STTSERVER.idFromName("turbo");
			let stub = env.STTSERVER.get(id);

			return stub.fetch(request);
		}

		return new Response(
			`Supported endpoints:
/websocket: Expects a WebSocket upgrade request`,
			{
				status: 200,
				headers: {
					"Content-Type": "text/plain",
				},
			},
		);
	},
};

// Durable Object
export class STTServer extends DurableObject {
	// Keeps track of all WebSocket connections
	sessions;

	constructor(ctx, env) {
		super(ctx, env);
		this.sessions = new Map();

		this.sb =    [15,25,35, 50, 75,100,125,150,200,250,300,350, 500];
		this.bb =    [30,50,70,100,150,200,250,300,400,500,600,700,1000];
		this.ante =  [ 4, 6, 9, 12, 20, 25, 30, 40, 50, 65, 80, 90, 130];

		this.startingPlayers = ['Dave', 'Chris', 'Andy', 'Nick'];

		this.state = {
			// tournament
			tournament: 1, 
			level: 0,
			connected: [0,0,0,0],

			// hand
			hand: 0, 
			dealer: 0,   // seat number holding the D button
			round: 0,
			turn: 0,     // seat number to act (red arrow); 0 = no arrow

			board: [],

			pot: [0], 
			bth: [0,0,0,0],
			btr: [0,0,0,0],
			lfb: [0,0,0,0],

			atc: 0,

			// per-seat data, indexed by seat number - 1
			message: [],
			players: [],
			chips: [3000, 3000, 3000, 3000],
			cards: [['Kh','Ks'], [], [], ['3d','8c']],   // [] = no cards shown
			actions: ['', '', '', ''],          // 'Check', 'Fold', ...
			controls: []
                
		};

		const players = this.startingPlayers.slice();
		for (let i = 0; i < players.length; i++) {
			const j = i + Math.floor(Math.random() * (players.length - i));
			[players[i], players[j]] = [players[j], players[i]];
		}
		this.state.players = players;

	}

	tableState = function(state,seat){
		let ts = {
			tournament: state.tournament, 
			hand: state.hand, 
			blinds: this.sb[state.level] + "/" + this.bb[state.level], 
			next_blinds: this.sb[state.level+1] + "/" + this.bb[state.level+1], 
			next_blind_time: '20:35',
			pot: state.pot.join('/'), 
			dealer: state.dealer,   // seat number holding the D button
			turn: state.turn,     // seat number to act (red arrow); 0 = no arrow
			atc: state.atc, 
			board: state.board,
			message: state.message[seat-1],
			// per-seat data, indexed by seat number - 1
			players: state.players,
			chips: state.chips,
			cards: state.cards.map((c,i) => i == seat-1 ? c : (c.length > 0 ? ['back','back'] : c)),   // [] = no cards shown
			actions: state.actions,          // 'Check', 'Fold', ...
			controls: state.turn-1 == seat ? state.controls : [],
			connected: state.connected                    
		};

		return ts;
	}

	async fetch(request) {
		// Name is the last path segment of the url, e.g. wss://host/dave -> "dave"
		const name = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
		// Seat number (1-based) of that player; 0 if the name is not seated
		const seat = this.state.players.findIndex(p => p.toLowerCase() === name.toLowerCase()) + 1;

		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `accept()` tells the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		server.accept();

		// Mark this seat as connected (seat is 1-based; 0 = not seated)
		if (seat > 0) this.state.connected[seat - 1] = 1;

		// Generate a random UUID for the session.
		const id = crypto.randomUUID();
		// Add the WebSocket connection to the map of active sessions.
		this.sessions.set(server, { id, name, seat });

		// Send the new client its state, and tell everyone else this seat is now connected.
		this.broadcast();

		server.addEventListener("message", (event) => {
			this.handleWebSocketMessage(server, event.data);
		});

		// When the client closes the connection, clean up the server side.
		server.addEventListener("close", () => {
			this.handleConnectionClose(server);
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async handleWebSocketMessage(ws, message) {

		const connection = this.sessions.get(ws);

		// Broadcast the message to all the connections,
		// including the one that sent the message.
		this.broadcast();
	}

	// Send every connected client the table state from its own seat's point of view.
	broadcast() {
		this.sessions.forEach((info, session) => {
			try {
				session.send(JSON.stringify(this.tableState(this.state, info.seat)));
			} catch (err) {
				console.error("send failed", err);
			}
		});
	}

	async handleConnectionClose(ws) {
		const info = this.sessions.get(ws);
		this.sessions.delete(ws);
		// Mark the seat disconnected unless the same seat still has another open socket
		if (info && info.seat > 0 &&
			![...this.sessions.values()].some(s => s.seat === info.seat)) {
			this.state.connected[info.seat - 1] = 0;
		}
		this.broadcast();
		// With web_socket_auto_reply_to_close (compat date >= 2026-04-07), the runtime
		// auto-replies to Close frames. Calling close() is safe but no longer required.
		ws.close(1000, "Durable Object is closing WebSocket");
	}
}
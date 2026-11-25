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

		this.state = {
			// tournament
			tournament: 1, 
			level: 0,
			connected: [0,0,0,0],
			sb:   [15,25,35, 50, 75,100,125,150,200,250,300,350, 500],
			bb:   [30,50,70,100,150,200,250,300,400,500,600,700,1000],
			ante: [ 4, 6, 9, 12, 20, 25, 30, 40, 50, 65, 80, 90, 130],
			startingPlayers: ['Dave', 'Chris', 'Andy', 'Nick'],

			// hand
			hand: 0, 
			dealer: 0,   // seat number holding the D button
			round: 0,
			turn: 0,     // seat number to act (red arrow); 0 = no arrow

            fullboard: [],
            evaluation: [],
            profile: [],
            profileSuit: [],
            mask: [],			

			board: [],

			pot: [0], 
			bth: [0,0,0,0],
			btr: [0,0,0,0],
			lfb: [0,0,0,0],

			atc: 0,

			// per-seat data, indexed by seat number - 1
			status: ['active','active','active','active'],
			message: [],
			players: [],
			chips: [3000, 3000, 3000, 3000],
			cards: [[], [], [], []],   // [] = no cards shown
			actions: ['', '', '', ''],          // 'Check', 'Fold', ...
			controls: []
                
		};

		const players = this.state.startingPlayers.slice();
		for (let i = 0; i < players.length; i++) {
			const j = i + Math.floor(Math.random() * (players.length - i));
			[players[i], players[j]] = [players[j], players[i]];
		}
		this.state.players = players;

		this.newHand();
	}

	createDeal = function(){

		var	playerCard = [],
			board = [],
			evaluation = [],
			profile = [],
			profileSuit = [],
			mask =[];

		// var random = function(depth){
		// 	var i,rand;
		// 	rand = [];
		// 	for(i=0; i<depth; i++){
		// 		rand[i] = Math.random();
		// 	}
		// 	return rand;
		// };

		var random = function(depth){
			// Workers has Web Crypto, not node's crypto.randomBytes
			var buf = crypto.getRandomValues(new Uint32Array(depth)), i, rand=[];
			for(i=0; i<depth; i++){
				rand[i] = buf[i] / 4294967296;   // [0,1)
			}
			return rand;
		};        

		var shuffle = function(depth) {
			var i, deck;
			deck = [];
			for (i = 0; i < 52; i++) {
				deck[i] = i;
			}

			var rand = random(depth)

			var t,j;
			for (i = 0; i < depth; i++) {
					// swap card at offset i with randomly chosen card from offset i
					// to end of deck
					j = i + Math.floor(rand[i] * (52 - i));
					t = deck[j];
					deck[j] = deck[i];
					deck[i] = t;
			}
			deck.length=depth;
			return deck;
		};

		//var shuffle = function(depth,  end) {
		//	var i, j, t, deck;
		//	deck = [];
		//	random(depth, function(rand){
		//		for (i = 0; i < depth; i++) {
		//				// swap card at offset i with randomly chosen card from offset i to end of deck
		//				j = i + Math.floor(rand[i] * (52 - i));
		//				t = deck[j] || j;
		//				deck[j] = deck[i] || i;
		//				deck[i] = t;
		//		}
		//		deck.length = depth;
		//		end(deck);
		//	});
		//};

		//var shuffle2 = function(depth) { // Floyd's Algorithm P
		//	var i, j, deck, rand, t;
		//	deck = [];
		//	depth = depth || 17; // hold'em with 6 players
		//	rand = random(depth);
		//	for (i = 0; i < depth; i++) {
		//		t = Math.floor(rand[i] * (52 - depth + i));
		//		for (j = 0; j < deck.length; j++) {
		//			if (deck[j] === t) {
		//				deck.splice(j, 0, 52 - depth + i);
		//				break;
		//			}
		//		}
		//		if (j === deck.length) {
		//			deck.splice(0, 0, t);
		//		}
		//	}
		//	return deck;
		//};

		var Card = function(cardNumber){
			this.cardSuit = Math.floor(cardNumber/13);
			this.cardRank = cardNumber%13;
			this.toString = function(){ return ["A","2","3","4","5","6","7","8","9","T","J","Q","K"][this.cardRank]+["s","h","d","c"][this.cardSuit]; };
		};

		var deal = () => {   // arrow fn so `this` is the Durable Object
			var player, card, i;
			i=0;
			var deck = shuffle(13)
			for (player=0; player<4; player++){
				playerCard[player] = [];
				for (card=0; card<2; card++){
					playerCard [player][card]= new Card(deck[i++]);
				}
			}
			for (card=0; card<5; card++) {
				board[card]= new Card(deck[i++]);
			}
			evaluate();
			for (var i = 0; i < board.length; i++) {
				board[i] = board[i].toString();
			}
			for (i = 0; i < 4; i++) {
				playerCard[i][0] = playerCard[i][0].toString();
				playerCard[i][1] = playerCard[i][1].toString();
			}
			this.state.cards = playerCard;
			this.state.fullboard = board;
			this.state.evaluation = evaluation;
			this.state.profile = profile;
			this.state.profileSuit = profileSuit;
			this.state.mask = mask;
		};

		var evaluate = function(){
			var player, card, i, j, cardCount, handValue1, handValue2, hand, suits, ranks, order, highCard, flushCard, flushSuit, count, straightRank, maxMeld, maxMeldRank, secondPairRank ;
			for (player=0;player<4;player++){
				hand=[];
				suits=[];
				ranks=[];
				order=[];
				highCard=[];
				flushCard=[];


				hand[0]=board[0];
				hand[1]=board[1];
				hand[2]=board[2];
				hand[3]=board[3];
				hand[4]=board[4];
				hand[5]=playerCard[player][0];
				hand[6]=playerCard[player][1];

				suits = [0,0,0,0];
				for (i=0;i<14;i++){ranks[i]=0;}
				for (i=0;i<53;i++){order[i]=0;}
				for (i=0;i< 7;i++){highCard[i]=0;}
				for (i=0;i<13;i++){flushCard[i]=0;}

				for (card=0; card<7; card++){
					suits[hand[card].cardSuit]++;
					ranks[hand[card].cardRank]++;
					order[(hand[card].cardSuit*13)+(hand[card].cardRank)]++;
				}
				ranks[13]=ranks[0];

				maxMeld=1;
				maxMeldRank=0;
				secondPairRank=0;

				//find the biggest meld e.g.fours,trips,a pair or no pair
				for (i=13;i>0;i--){
					if (ranks[i]>maxMeld) {
						maxMeld=ranks[i];
						maxMeldRank=i;
					}
				}
				//for pairs or trips find if there is a second pair
				if (maxMeld==2 || maxMeld==3){
					for (i=13;i>0;i--){
						if (ranks[i]>1 && i!=maxMeldRank){
							secondPairRank=i;
							break;
						}
					}
				}
				//make a list of high cards of rank different from maxMeld and secondPair
				cardCount=0;
				for (i=13;i>0;i--){
					if (ranks[i]>0 && i!=maxMeldRank && i!=secondPairRank) {
						highCard[cardCount]=i;
						cardCount++;
					}
				}
				//assign values for fours,full house,trips,two pairs,pairs and no pair
				handValue1=0;
				handValue2=0;
				var handProfile1=[], handProfile2=[], straightFlushRank;
				switch (maxMeld) {
					case 4:
						handValue1=8*0x100000 + (maxMeldRank+1)*0x10000 + (highCard[0]+1)*0x1000 ;
						handProfile1=[maxMeldRank,maxMeldRank,maxMeldRank,maxMeldRank,highCard[0]];
						break;
					case 3:
						if (secondPairRank!==0) {
							handValue1=7*0x100000 + (maxMeldRank+1)*0x10000 + (secondPairRank+1)*0x1000 ;
							handProfile1=[maxMeldRank,maxMeldRank,maxMeldRank,secondPairRank,secondPairRank];
						}
						else {
							handValue1=4*0x100000 + (maxMeldRank+1)*0x10000 + (highCard[0]+1)*0x1000 + (highCard[1]+1)*0x100;
							handProfile1=[maxMeldRank,maxMeldRank,maxMeldRank,highCard[0],highCard[1]];
						}
						break;
					case 2:
						if (secondPairRank!==0) {
							handValue1=3*0x100000 + (maxMeldRank+1)*0x10000 + (secondPairRank+1)*0x1000+ (highCard[0]+1)*0x100 ;
							handProfile1=[maxMeldRank,maxMeldRank,secondPairRank,secondPairRank,highCard[0]];
						}
						else {
							handValue1=2*0x100000 + (maxMeldRank+1)*0x10000 + (highCard[0]+1)*0x1000 + (highCard[1]+1)*0x100 + (highCard[2]+1)*0x10;
							handProfile1=[maxMeldRank,maxMeldRank,highCard[0],highCard[1],highCard[2]];
						}
						break;
					case 1:
						handValue1=1*0x100000 + (highCard[0]+1)*0x10000 + (highCard[1]+1)*0x1000 + (highCard[2]+1)*0x100 + (highCard[3]+1)*0x10 +(highCard[4]+1);
						handProfile1=[highCard[0],highCard[1],highCard[2],highCard[3],highCard[4]];
						break;
				}
				//check for flush
				flushSuit=-1;
				for (i=0;i<4;i++){
					if (suits[i]>=5){
						flushSuit=i;
					}
				}
				if (flushSuit>=0){
					// check for straight flush and evaluate
					order[(flushSuit+1)*13]=order[flushSuit*13];
					count=0;
					for (i=(flushSuit+1)*13;i>=flushSuit*13;i--){
						if (order[i]>0)
							count++;
						else
							count=0;
						if (count==5){
							handValue2 = 9*0x100000 + (i-flushSuit*13+5)*0x10000;
							straightFlushRank=i-flushSuit*13+5;
							handProfile2 = [straightFlushRank-1,straightFlushRank-2,straightFlushRank-3,straightFlushRank-4,straightFlushRank-5];
							break;
						}
					}
					if (handValue2===0){
						//evaluate flush
						count=0;
						for (i=(flushSuit+1)*13;i>=flushSuit*13;i--){
							if (order[i]>0){
								flushCard[count]=i-flushSuit*13;
								count++;
							}
						}
						handValue2 = 6*0x100000 + (flushCard[0]+1)*0x10000 + (flushCard[1]+1)*0x1000 + (flushCard[2]+1)*0x100 + (flushCard[3]+1)*0x10 + (flushCard[4]+1) ;
						handProfile2 = [flushCard[0],flushCard[1],flushCard[2],flushCard[3],flushCard[4]];
					}
				} else {
					//check for straight
					count=0;
					straightRank=0;
					for (i=13;i>=0;i--){
						if(ranks[i]>0)
							count++;
						else
							count=0;
						if (count==5) {
							straightRank=i+5;
							handValue2=5*0x100000 +straightRank*0x10000;
							handProfile2 = [straightRank-1,straightRank-2,straightRank-3,straightRank-4,straightRank-5];
							break;
						}
					}
				}
				if (handValue1>handValue2){
					evaluation[player]=handValue1;
					profile[player]=handProfile1;
					profileSuit[player]=-1;
				}
				else {
					evaluation[player]=handValue2;
					profile[player]=handProfile2;
					profileSuit[player]=flushSuit;
				}
				mask[player]=[0,0,0,0,0,0,0];

				for (i=0;i<5;i++){
					if (profile[player][i]==13) profile[player][i]=0;
					for (j=0;j<7;j++){
						if (mask[player][j]===0) {
							if (profileSuit[player]==-1){
								if (hand[j].cardRank==profile[player][i]){
									mask[player][j]=1;
									break;
								}
							}
							else {
								if (hand[j].cardRank==profile[player][i] && hand[j].cardSuit==profileSuit[player]){
									mask[player][j]=1;
									break;
								}
							}
						}
					}
				}
			}
		};

		deal();

	};	

	newHand =  function(){

		this.createDeal();

		this.state.status = this.state.status.map(s => s == 'out' ? 'out' : 'active') //reset remaing players to active 

		this.state.hand++;
		// clear last hand's betting state
		const n = this.state.status.length;
		this.state.board = [];
		this.state.pot = [0];
		this.state.atc = 0;
		this.state.bth = Array(n).fill(0);
		this.state.btr = Array(n).fill(0);
		this.state.lfb = Array(n).fill(0);
		this.state.actions = Array(n).fill('');
		this.state.dealer = this.nextButton(this.state.dealer);
		this.payBlinds();
		this.state.turn = this.nextTurn(this.state.turn);

		this.state.pot = this.calculateSidePots();

		this.state.controls = this.setControls();

	}

	nextButton =  function(dealer){
		if (dealer == 0) return 1;
		return this.nextTurn(dealer);
	}

	payBlinds = function(){ 
		// seats are numbered from 1; chips, bth, btr and actions are indexed by seat - 1
		const sb = this.state.sb[this.state.level];
		this.state.turn = this.nextTurn(this.state.dealer);
		this.postBlind(this.state.turn, sb);

		const bb = this.state.bb[this.state.level];
		this.state.turn = this.nextTurn(this.state.turn);
		this.postBlind(this.state.turn, bb);
	}

	postBlind = function(seat, amount){
		const i = seat - 1;
		const paid = Math.min(amount, this.state.chips[i]);   // short stack posts what it has
		this.state.chips[i] -= paid;
		if (this.state.chips[i] == 0) this.state.status[i] = 'allin';
		this.state.actions[i] = 'Blind ' + paid;
		this.state.bth[i] = paid;
		this.state.btr[i] = paid;
	}

	setControls = function(){
		return ['Fold','Raise3BB',RaisePot,RaiseAllIn,Raise]
	}

	// next seat after lastTurn (1-based, wrapping), skipping players who are out
	nextTurn = function(lastTurn){
		const n = this.state.status.length;
		let seat = lastTurn;
		for (let k = 0; k < n; k++) {
			seat = seat % n + 1;
			if (this.state.status[seat - 1] == 'active' && seat != lastTurn) return seat;
		}
		return 0;   // nobody left except maybe last player
	}

	calculateSidePots = function() {
        var allInAmount =0,
                i,
                nextAllIn,
                nextAllInAmount,
                sidePot,
                activeSidePot = 0,
                totalPot = 0;

        const pot = [0,0,0,0,0,0];
        const potLevel = [0,0,0,0,0,0];
        const allInSidePot = [];

        var betThisHand = this.state.bth
        var chips = this.state.chips       

        for (sidePot=0; true ;sidePot++){



            nextAllIn =99;
            nextAllInAmount =9999999;

            //find the next all-in level and amount
            for (i=0;i<4;i++) {
                if (chips[i] === 0 && betThisHand[i] > allInAmount	&& betThisHand[i] < nextAllInAmount) {
                    nextAllIn = i+1;
                    nextAllInAmount = betThisHand[i];
                }
            }

            potLevel[sidePot]=allInAmount;

            //compute the value of sidepot for this level
            for (i=0;i<4;i++) {
                // if (seat[i].player){
                    if (betThisHand[i] > nextAllInAmount){
                        pot[sidePot]+= (nextAllInAmount-allInAmount);
                    } else if (betThisHand[i] >= allInAmount){
                        pot[sidePot]+= (betThisHand[i]-allInAmount);
                    }
                // }
            }
            //record the seatno contending for this sidepot only
            for (i=0;i<4;i++) {
                // if (seat[i].player){
                    if (betThisHand[i]==nextAllInAmount){
                        allInSidePot[i]=sidePot;
                    }
                // }
            }
            activeSidePot=sidePot;
            if (nextAllIn==99) break;
            allInAmount = nextAllInAmount;
        }

        for (i=0;i<=activeSidePot; i++) {
            totalPot+=pot[i];
        }

        return pot.slice(0, activeSidePot + 1);   // drop unused side pots

    };

	tableState = function(state,seat){
		let ts = {
			tournament: state.tournament, 
			hand: state.hand, 
			blinds: state.sb[state.level] + "/" + state.bb[state.level], 
			next_blinds: state.sb[state.level+1] + "/" + state.bb[state.level+1], 
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

		let msg;
		try { msg = JSON.parse(message); } catch (err) { return; }   // ignore non-JSON

		if (msg.action === 'Chat' && typeof msg.text === 'string' && msg.text.trim()) {
			// "\nName: text" is appended to every seat's message
			const seat = connection ? connection.seat : 0;
			const who = (seat > 0 ? this.state.players[seat - 1] : connection?.name) || 'Unknown';
			const line = '\n' + who + ': ' + msg.text.trim();
			for (let i = 0; i < this.state.players.length; i++) {
				this.state.message[i] = (this.state.message[i] || '') + line;
			}
		}

		if (msg.action === 'Fold') {
			// only the player whose turn it is may fold
			const seat = connection ? connection.seat : 0;
			if (seat > 0 && seat === this.state.turn && this.state.status[seat - 1] == 'active') {
				this.state.status[seat - 1] = 'folded';
				this.state.cards[seat - 1] = [];
				this.state.actions[seat - 1] = 'Fold';
				this.state.turn = this.nextTurn(seat);
			}
		}

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
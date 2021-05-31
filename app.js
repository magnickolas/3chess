const express = require('express')
const app = express()
const serv = require('http').createServer(app)
const io = require('socket.io')(serv)
const config = require('./config.js');

// Parse args
const yargs = require('yargs');

const argv = yargs
    .option('port', {
        alias: 'p',
        description: 'Port to run the server at',
        type: 'int',
    })
    .option('time', {
        alias: 't',
        description: 'Time control (minutes)',
        type: 'float',
    })
    .option('additional_time', {
        alias: 'a',
        description: 'Time advance per move (seconds)',
        type: 'int',
    })
    .help()
    .alias('help', 'h')
    .argv;

if (argv.port) {
    config.port = argv.port;
}
if (argv.time) {
    config.time = argv.time;
}
if (argv.additional_time) {
    config.additional_time = argv.additional_time;
}

app.get("/", function (req, res) {
    res.sendFile(__dirname + "/client/index.html")
})
app.use("/client", express.static(__dirname + "/client"))

serv.setMaxListeners(0)

serv.listen(config.port)

var sockets_list = {}

class Piece {
    constructor(type, side, moved = false) {
        this.type = type
        this.side = side
        this.moved = moved
    }
}

class Board {
    constructor() {
        this.cells = {}
        for (let s = 0; s < 3; s++) {
            this.cells[s] = {}
            for (let i = 0; i < 4; i++) {
                this.cells[s][i] = {}
                for (let j = 0; j < 8; j++) {
                    this.cells[s][i][j] = new Piece({ name: "" }, -1)
                }
            }
        }
        for (let s = 0; s < 3; s++) {
            for (let j = 0; j < 8; j++) {
                this.cells[s][1][j] = new Piece({ name: "P", enpass: false }, s)
            }
            this.cells[s][0][0] = this.cells[s][0][7] = new Piece({ name: "R" }, s)
            this.cells[s][0][1] = this.cells[s][0][6] = new Piece({ name: "N" }, s)
            this.cells[s][0][2] = this.cells[s][0][5] = new Piece({ name: "B" }, s)
            this.cells[s][0][3] = new Piece({ name: "Q" }, s)
            this.cells[s][0][4] = new Piece({ name: "K" }, s)
            if (s == 1) {
                let tmp = this.cells[s][0][3]
                this.cells[s][0][3] = this.cells[s][0][4]
                this.cells[s][0][4] = tmp
            }
        }
    }
    piece(s, i, j) {
        return this.cells[s][i][j]
    }
}

class Player {
    constructor(id, side) {
        this.id = id
        this.side = side
        this.status = ""
        this.cells = {}
        for (let s = 0; s < 3; s++) {
            this.cells[s] = {}
            for (let i = 0; i < 4; i++) {
                this.cells[s][i] = {}
                for (let j = 0; j < 8; j++) {
                    this.cells[s][i][j] = "off"
                }
            }
        }
    }
}

players_list = {}

used_sides = {}


Array.prototype.equals = function (array) {
    if (!array)
        return false;
    if (this.length != array.length)
        return false;
    for (let i = 0, l = this.length; i < l; i++) {
        if (this[i] instanceof Array && array[i] instanceof Array) {
            if (!this[i].equals(array[i]))
                return false;
        } else if (this[i] != array[i]) {
            return false;
        }
    }
    return true;
}

Object.defineProperty(Array.prototype, "equals", { enumerable: false });

function cloneObject(obj) {
    let clone = {};
    for (let i in obj) {
        if (obj[i] != null && typeof (obj[i]) == "object")
            clone[i] = cloneObject(obj[i]);
        else
            clone[i] = obj[i];
    }
    return clone;
}

let board = null

let cur_side_move = 3
let lose_side = -1

let hlighted = []
let checked = []

let INIT_TIME = config.time * 60 * 1000
let ADD_TIME = config.additional_time * 1000

let timers = [INIT_TIME, INIT_TIME, INIT_TIME]
let MOVE_START_TIME = null

let process_game = function (q) {
    let socket = sockets_list[q]

    let get_type = function (c) {
        return board.cells[c[0]][c[1]][c[2]].type.name
    }
    let get_side = function (c) {
        return board.cells[c[0]][c[1]][c[2]].side
    }
    let is_moved = function (c) {
        return board.cells[c[0]][c[1]][c[2]].moved
    }

    let is_castling = function(c1, c2) {
        let rc = [c1[0], c1[1], c2[2] < c1[2] ? 0 : 7]
        if (c1[0] != c2[0] || c1[1] != c2[1] || Math.abs(c1[2] - c2[2]) != 2 ||
          get_type(c1) != "K" || is_moved(c1) || is_moved(rc)) {
            return false
        }
        let from = Math.min(c1[2], c2[2])
        let to = Math.max(c1[2], c2[2])
        for (let i = from; i <= to; i++) {
            let c = [c1[0], c1[1], i]
            if (is_checked(c, get_side(c1)) || (get_side(c) != -1 && !c.equals(c1))) {
                return false
            }
        }
        return true
    }

    let beaten_list = function (c1, at_side, beat = true, include_castling = false) {
        let piece_side1 = get_side(c1)
        let piece_t1 = get_type(c1)
        if (piece_side1 != at_side) {
            return []
        }
        let fwd = function (c, force = false) {
            if (c.length == 0) {
                return []
            }
            if (!force && piece_side1 != c[0]) {
                return bwd(c, true)
            }
            if (c[1] < 3) {
                return [[c[0], c[1] + 1, c[2]]]
            }
            let res = [[(c[0] + (c[2] < 4 ? 1 : 2)) % 3, c[1], 7 - c[2]]]
            if (c[2] == 3) {
                res.push([(c[0] + 2) % 3, c[1], 7 - c[2]])
            } else if (c[2] == 4) {
                res.push([(c[0] + 1) % 3, c[1], 7 - c[2]])
            }
            return res
        }
        let bwd = function (c, force = false) {
            if (c.length == 0) {
                return []
            }
            if (!force && piece_side1 != c[0]) {
                return fwd(c, true)
            }
            if (c[1] > 0) {
                return [[c[0], c[1] - 1, c[2]]]
            } else {
                return []
            }
        }
        let left = function (c, force = false) {
            if (c.length == 0) {
                return []
            }
            if (!force && piece_side1 != c[0]) {
                return right(c, true)
            }
            if (c[2] > 0) {
                return [[c[0], c[1], c[2] - 1]]
            } else {
                return []
            }
        }
        let right = function (c, force = false) {
            if (c.length == 0) {
                return []
            }
            if (!force && piece_side1 != c[0]) {
                return left(c, true)
            }
            if (c[2] < 7) {
                return [[c[0], c[1], c[2] + 1]]
            } else {
                return []
            }
        }
        let diag = function (c) {
            if (c.length == 0) {
                return []
            }
            let res = []
            if (c[1] > 0) {
                if (c[2] > 0) {
                    res.push([c[0], c[1] - 1, c[2] - 1])
                }
                if (c[2] < 7) {
                    res.push([c[0], c[1] - 1, c[2] + 1])
                }
            }
            if (c[1] < 3) {
                if (c[2] > 0) {
                    res.push([c[0], c[1] + 1, c[2] - 1])
                }
                if (c[2] < 7) {
                    res.push([c[0], c[1] + 1, c[2] + 1])
                }
            } else {
                if (c[2] > 0 && c[2] < 5) {
                    res.push([(c[0] + 1) % 3, c[1], 8 - c[2]])
                }
                if (c[2] < 4) {
                    res.push([(c[0] + 1) % 3, c[1], 6 - c[2]])
                }
                if (c[2] > 2 && c[2] < 7) {
                    res.push([(c[0] + 2) % 3, c[1], 6 - c[2]])
                }
                if (c[2] > 3) {
                    res.push([(c[0] + 2) % 3, c[1], 8 - c[2]])
                }
            }
            return res
        }
        let knight = function (c) {
            if (c.length == 0) {
                return []
            }
            let res = []
            if (c[1] > 0) {
                if (c[2] > 1) {
                    res.push([c[0], c[1] - 1, c[2] - 2])
                }
                if (c[2] < 6) {
                    res.push([c[0], c[1] - 1, c[2] + 2])
                }
            }
            if (c[1] > 1) {
                if (c[2] > 0) {
                    res.push([c[0], c[1] - 2, c[2] - 1])
                }
                if (c[2] < 7) {
                    res.push([c[0], c[1] - 2, c[2] + 1])
                }
            }
            if (c[1] < 2) {
                if (c[2] > 0) {
                    res.push([c[0], c[1] + 2, c[2] - 1])
                }
                if (c[2] < 7) {
                    res.push([c[0], c[1] + 2, c[2] + 1])
                }
            }
            if (c[1] < 3) {
                if (c[2] > 1) {
                    res.push([c[0], c[1] + 1, c[2] - 2])
                }
                if (c[2] < 6) {
                    res.push([c[0], c[1] + 1, c[2] + 2])
                }
            }
            if (c[1] > 1) {
                if (c[2] > 0 && c[2] < 5) {
                    res.push([(c[0] + 1) % 3, 5 - c[1], 8 - c[2]])
                }
                if (c[2] < 4) {
                    res.push([(c[0] + 1) % 3, 5 - c[1], 6 - c[2]])
                }
                if (c[2] > 2 && c[2] < 7) {
                    res.push([(c[0] + 2) % 3, 5 - c[1], 6 - c[2]])
                }
                if (c[2] > 3) {
                    res.push([(c[0] + 2) % 3, 5 - c[1], 8 - c[2]])
                }
            }
            if (c[1] > 2) {
                if (c[2] > 1 && c[2] < 5) {
                    res.push([(c[0] + 1) % 3, c[1], 9 - c[2]])
                }
                if (c[2] < 4) {
                    res.push([(c[0] + 1) % 3, c[1], 5 - c[2]])
                }
                if (c[2] > 2 && c[2] < 6) {
                    res.push([(c[0] + 2) % 3, c[1], 5 - c[2]])
                }
                if (c[2] > 3) {
                    res.push([(c[0] + 2) % 3, c[1], 9 - c[2]])
                }
            }
            return res
        }
        let btn_pcs = []
        if (piece_t1 == "P") {
            if (!beat) {
                let lst = fwd(c1)
                let new_lst = []
                for (let i = 0; i < lst.length; i++) {
                    if (get_side(lst[i]) == -1) {
                        btn_pcs.push(lst[i])
                        new_lst = new_lst.concat(fwd(lst[i]))
                    }
                }
                if (c1[0] == piece_side1 && c1[1] == 1 && fwd(c1)[0]) {
                    for (let i = 0; i < new_lst.length; i++) {
                        if (get_side(new_lst[i]) == -1) {
                            btn_pcs.push(new_lst[i])
                        }
                    }
                }
            } else {
                let lst = fwd(c1)
                if (lst.length > 0) {
                    btn_pcs = btn_pcs.concat(left(lst[0]))
                    btn_pcs = btn_pcs.concat(right(lst[0]))
                    if (lst.length > 1) {
                        if (c1[2] == 3) {
                            btn_pcs = btn_pcs.concat(right(lst[1]))
                        }
                        if (c1[2] == 4) {
                            btn_pcs = btn_pcs.concat(left(lst[1]))
                        }
                    }
                }
            }
        }
        if (piece_t1 == "K") {
            btc_pcs = btn_pcs.concat(fwd(c1))
            btc_pcs = btn_pcs.concat(bwd(c1))
            btc_pcs = btn_pcs.concat(left(c1))
            btc_pcs = btn_pcs.concat(right(c1))
            btc_pcs = btn_pcs.concat(diag(c1))
            if (include_castling) {
                if (c1[2] > 1 && is_castling(c1, left(left(c1)[0])[0])) {
                    btn_pcs.push(left(left(c1)[0])[0])
                }
                if (c1[2] < 6 && is_castling(c1, right(right(c1)[0])[0])) {
                    btn_pcs.push(right(right(c1)[0])[0])
                }
            }
        }
        if (piece_t1 == "N") {
            btn_pcs = knight(c1)
        }
        if (piece_t1 == "R" || piece_t1 == "Q") {
            let cur = c1
            while (fwd(cur).length > 0) {
                cur = fwd(cur)[0]
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            let cdir = false
            while (bwd(cur, cdir).length > 0) {
                let prev_side = cur[0]
                cur = bwd(cur, cdir)[0]
                if (cur[0] != prev_side) {
                    cdir = !cdir
                }
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            while (left(cur).length > 0) {
                cur = left(cur)[0]
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            while (right(cur).length > 0) {
                cur = right(cur)[0]
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
        }
        if (piece_t1 == "B" || piece_t1 == "Q") {
            let cur = c1
            while (fwd(cur).length > 0 && left(fwd(cur)[0]).length > 0) {
                cur = left(fwd(cur)[0])[0]
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            while (left(cur).length > 0 && fwd(left(cur)[0]).length > 0) {
                cur = fwd(left(cur)[0])[0]
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            while (fwd(cur).length > 0 && right(fwd(cur)[0]).length > 0) {
                cur = right(fwd(cur)[0])[0]
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            while (right(cur).length > 0 && fwd(right(cur)[0]).length > 0) {
                cur = fwd(right(cur)[0])[0]
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            let cdir = false
            while (bwd(cur, cdir).length > 0) {
                let prev_side = cur[0]
                cur = bwd(cur, cdir)[0]
                if (cur[0] != prev_side) {
                    cdir = !cdir
                }
                let lst = left(cur, cdir)
                if (lst.length > 0) {
                    cur = lst[0]
                    if (get_side(cur) != -1) {
                        if (get_side(cur) != piece_side1) {
                            btn_pcs.push(cur)
                        }
                        break
                    }
                    btn_pcs.push(cur)
                }
            }
            cur = c1
            cdir = false
            while (left(cur, cdir).length > 0 &&
                  bwd(left(cur, cdir)[0], cdir).length > 0) {
                let prev_side = cur[0]
                cur = bwd(left(cur, cdir)[0], cdir)[0]
                if (cur[0] != prev_side) {
                    cdir = !cdir
                }
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
            cur = c1
            cdir = false
            while (bwd(cur, cdir).length > 0) {
                let prev_side = cur[0]
                cur = bwd(cur, cdir)[0]
                if (cur[0] != prev_side) {
                    cdir = !cdir
                }
                let lst = right(cur, cdir)
                if (lst.length > 0) {
                    cur = lst[0]
                    if (get_side(cur) != -1) {
                        if (get_side(cur) != piece_side1) {
                            btn_pcs.push(cur)
                        }
                        break
                    }
                    btn_pcs.push(cur)
                }
            }
            cur = c1
            cdir = false
            while (right(cur, cdir).length > 0 &&
                  bwd(right(cur, cdir)[0], cdir).length > 0) {
                let prev_side = cur[0]
                cur = bwd(right(cur, cdir)[0], cdir)[0]
                if (cur[0] != prev_side) {
                    cdir = !cdir
                }
                if (get_side(cur) != -1) {
                    if (get_side(cur) != piece_side1) {
                        btn_pcs.push(cur)
                    }
                    break
                }
                btn_pcs.push(cur)
            }
        }

        return btn_pcs
    }

    let is_beaten = function (lst, c2) {
        for (let i = 0, l = lst.length; i < l; i++) {
            if (lst[i].equals(c2)) {
                return true
            }
        }
        return false
    }

    let is_checked = function (c, force_side = null) {
        for (let s = 0; s < 3; s++) {
            for (let i = 0; i < 4; i++) {
                for (let j = 0; j < 8; j++) {
                    let cell = [s, i, j]
                    let side = force_side != null ? force_side : get_side(c)
                    if (get_side(cell) != side && get_side(cell) != -1 &&
                        is_beaten(beaten_list(cell, get_side(cell)), c)) {
                        return true
                    }
                }
            }
        }
        return false
    }

    let is_possible_move = function (c1, c2) {
        let cur_piece = board.piece(c1[0], c1[1], c1[2])
        let piece1 = cloneObject(cur_piece)
        board.cells[c1[0]][c1[1]][c1[2]] = new Piece({ name: "" }, -1)
        let piece2 = board.piece(c2[0], c2[1], c2[2])
        if (c2[1] == 0 && cur_piece.type.name == "P") {
            cur_piece.type = { name: "Q" }
        }
        board.cells[c2[0]][c2[1]][c2[2]] = cur_piece

        let king_cell = null
        for (let s = 0; s < 3; s++) {
            for (let i = 0; i < 4; i++) {
                for (let j = 0; j < 8; j++) {
                    if (get_type([s, i, j]) == "K" && get_side([s, i, j]) == piece1.side) {
                        king_cell = [s, i, j]
                    }
                }
            }
        }
        let res = !is_checked(king_cell)
        board.cells[c1[0]][c1[1]][c1[2]] = piece1
        board.cells[c2[0]][c2[1]][c2[2]] = piece2
        return res
    }

    let cur_beaten_list = function (c1, force_side = null) {
        if (!(force_side != null && get_side(c1) == force_side) &&
              get_side(c1) != players_list[q].side) {
            return []
        }
        let btn_pcs = beaten_list(c1, get_side(c1), false, true)
        let btn_pcs_att = beaten_list(c1, get_side(c1), true)
        let res = []
        for (let s = 0; s < 3; s++) {
            for (let i = 0; i < 4; i++) {
                for (let j = 0; j < 8; j++) {
                    let c2 = [s, i, j]
                    if (get_side(c1) != get_side(c2) &&
                          get_type(c2) != "K" &&
                          (is_beaten(btn_pcs, c2) ||
                            (get_type(c1) == "P" &&
                              get_side(c2) != -1 &&
                              is_beaten(btn_pcs_att, c2))
                          ) &&
                          is_possible_move(c1, c2)) {
                        res.push(c2)
                    }
                }
            }
        }
        return res
    }

    let is_mate = function () {
        for (let cur_side = 0; cur_side < 3; cur_side++) {
            let is_cur_mate = true
            for (let s = 0; s < 3; s++) {
                for (let i = 0; i < 4; i++) {
                    for (let j = 0; j < 8; j++) {
                        let cell = [s, i, j]
                        if (get_side(cell) == cur_side) {
                            let moves = cur_beaten_list(cell, cur_side)
                            for (let i = 0; i < moves.length; i++) {
                                if (is_possible_move(cell, moves[i])) {
                                    is_cur_mate = false
                                }
                            }
                        }
                    }
                }
            }
            if (is_cur_mate) {
                return true
            }
        }
        return false
    }

    let notified = false
    socket.on("make_move", function (c1, c2) {
        if (cur_side_move != 3 &&
              c2 != null &&
              get_side(c1) != get_side(c2) &&
              get_type(c2) != "K" &&
              get_side(c1) == players_list[q].side &&
              get_side(c1) == cur_side_move) {
            let moved = false
            let beat = false
            if (is_castling(c1, c2)) {
                moved = true
                let c3 = [c2[0], c2[1], c2[2] < c1[2] ? 0 : 7]
                let c4 = [c1[0], c1[1], c3[2] == 0 ? c2[2] + 1 : c2[2] - 1]
                let king = board.cells[c1[0]][c1[1]][c1[2]]
                let rook = board.cells[c3[0]][c3[1]][c3[2]]
                board.cells[c1[0]][c1[1]][c1[2]] = new Piece({ name: "" }, -1)
                board.cells[c3[0]][c3[1]][c3[2]] = new Piece({ name: "" }, -1)
                king.moved = true
                board.cells[c2[0]][c2[1]][c2[2]] = king
                rook.moved = true
                board.cells[c4[0]][c4[1]][c4[2]] = rook

            } else {
                let btn_pcs = beaten_list(c1, cur_side_move, get_side(c2) != -1)
                if (is_beaten(btn_pcs, c2) && is_possible_move(c1, c2)) {
                    moved = true

                    let cur_piece = board.piece(c1[0], c1[1], c1[2])
                    board.cells[c1[0]][c1[1]][c1[2]] = new Piece({ name: "" }, -1)
                    if (c2[1] == 0 && cur_piece.type.name == "P") {
                        cur_piece.type = { name: "Q" }
                    }
                    if (get_side(c2) != -1) {
                        beat = true
                    }
                    cur_piece.moved = true
                    board.cells[c2[0]][c2[1]][c2[2]] = cur_piece
                }
            }
            if (moved) {
                timers[cur_side_move] += ADD_TIME
                for (let q in sockets_list) {
                    sockets_list[q].emit(beat ? "beat_move" : "made_move")
                }
                for (let q in sockets_list) {
                    for (let i = 0; i < hlighted.length; i++) {
                        let cell = hlighted[i]
                        sockets_list[q].emit(
                          "update_cell",
                          {
                            side: cell[0],
                            row: cell[1],
                            col: cell[2],
                            status: "hoff",
                            piece: board.piece(cell[0], cell[1], cell[2])
                          }
                        )
                    }
                }
                hlighted = [c1, c2]
                for (let q in sockets_list) {
                    sockets_list[q].emit(
                      "update_cell",
                      {
                        side: c1[0],
                        row: c1[1],
                        col: c1[2],
                        status: "hlight",
                        piece: board.piece(c1[0], c1[1], c1[2])
                      }
                    )
                    sockets_list[q].emit(
                      "update_cell",
                      {
                        side: c2[0],
                        row: c2[1],
                        col: c2[2],
                        status: "hlight",
                        piece: board.piece(c2[0], c2[1], c2[2])
                      }
                    )
                }

                checked = []

                for (let s = 0; s < 3; s++) {
                    for (let i = 0; i < 4; i++) {
                        for (let j = 0; j < 8; j++) {
                            let c = [s, i, j]
                            let status = "checkoff"
                            if (get_type(c) == "K" && is_checked(c)) {
                                status = "checkon"
                                checked.push(c)
                            }
                            for (let q in sockets_list) {
                                sockets_list[q].emit(
                                  "update_cell",
                                  {
                                    side: c[0],
                                    row: c[1],
                                    col: c[2],
                                    status: status,
                                    piece: board.piece(c[0], c[1], c[2])
                                  }
                                )
                            }
                        }
                    }
                }
                
                if (is_mate()) {
                    console.log("MATE")
                    cur_side_move = 3
                } else {
                    cur_side_move = (cur_side_move + 1) % 3
                }
            }

        }
    })

    socket.on("request_beaten", function (c1) {
        socket.emit("receive_beaten", cur_beaten_list(c1))
    })

    socket.on("request_board", function() {
        socket.emit("receive_board", board)
        refresh_board(socket)
    })

    socket.on("loaded", function() {refresh_board(socket)})
}

let refresh_board = function (socket) {
    for (let i = 0; i < hlighted.length; i++) {
        let cell = hlighted[i]
        socket.emit(
          "update_cell",
          {
            side: cell[0],
            row: cell[1],
            col: cell[2],
            status: "hlight",
            piece: board.piece(cell[0], cell[1], cell[2])
          }
        )
    }
    for (let i = 0; i < checked.length; i++) {
        let cell = checked[i]
        socket.emit(
          "update_cell",
          {
            side: cell[0],
            row: cell[1],
            col: cell[2],
            status: "checkon",
            piece: board.piece(cell[0], cell[1], cell[2])
          }
        )
    }
}

let init_game = function () {
    board = new Board()
    cur_side_move = 0
    let notified = false
    setInterval(function() {
        if (cur_side_move == 3) {
            if (!notified) {
                for (let q in sockets_list) {
                    sockets_list[q].emit("game_end")
                }
                notified = true
            }
        } else {
            let cur_elapsed = MOVE_START_TIME == null ? 0 :  Date.now() - MOVE_START_TIME
            MOVE_START_TIME = Date.now()
            let i = cur_side_move
            if (i != 3) {
                timers[i] -= cur_elapsed
                if (timers[i] <= 0) {
                    timers[i] = 0
                    cur_side_move = 3
                }
            }
        }
        for (let q in sockets_list) {
            sockets_list[q].emit("update_timers", timers)
        }
    }, 250)
}

let started = false

let CHAT_MESSAGES = []

io.sockets.on("connection", function (socket) {
    console.log("socket connection")
    let cur_id = Math.random()
    while (cur_id in sockets_list) {
        cur_id = Math.random()
    }
    socket.id = cur_id
    let pside = 0
    while (pside in used_sides) {
        ++pside
    }
    if (pside > 2) {
        socket.disconnect()
        return
    }
    sockets_list[socket.id] = socket
    used_sides[pside] = true
    socket.emit("side", pside)
    players_list[socket.id] = new Player(socket.id, pside)
    socket.on('send_message', function(data) {
        if (data != '') {
            let player_name = pside == 0 ? "White" : pside == 1 ? "Black" : "Gray"
            let color = pside == 0 ? "black" : pside == 1 ? "green" : "blue"
            for (let q in sockets_list) {
                sockets_list[q].emit(
                  "add_to_chat",
                  '<font color="' + color + '">' + player_name + ": " + data + '</font>'
                )
            }
        }
    })
    socket.on("disconnect", function () {
        delete sockets_list[socket.id]
        delete players_list[socket.id]
        delete used_sides[pside]
    })
    if (started) {
        process_game(socket.id)
    } else if ((0 in used_sides) && (1 in used_sides) && (2 in used_sides)) {
        started = true
        init_game()
        MOVE_START_TIME = Date.now()
        for (let q in sockets_list) {
            process_game(q)
        }
    }
})


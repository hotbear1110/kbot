#!/usr/bin/env node
'use strict';

const utils = require('../utils/utils.js');
const kb = require('../handler.js').kb;
const creds = require('../credentials/config.js');
const shell = require("child_process");
const got = require('got');
const lastfm = require("./lastfm.js");

const talkedRecently = new Set();
const searchCache = [];

module.exports = {
    name: 'kb spotify',
    invocation: async (channel, user, message) => {
        try {
            // get correct param depending on if message is an alias
            const msg = (message.split(' ')[1] === "spotify") ?
                utils.getParam(message.toLowerCase()) :
                utils.getParam(message.toLowerCase(), 1);

            /*
            *
            *   SPOTIFY INTEGRATION
            *
            */
            const refresh = async(col, userRaw = user['user-id']) => {
                const username = userRaw.replace("@", "").replace(",", "")

                const refresh = await utils.query(`
                    SELECT *
                    FROM access_token
                    WHERE platform="spotify" AND user=? OR username=?`,
                    [username, username]);

                if (col === "access_token") {
                    return refresh[0].access_token;
                }
                if (col === "refresh_token") {
                    return refresh[0].refresh_token;
                }
            }

            const apiCall = async(link, userRaw, method = "GET") => {
                if (userRaw && userRaw != user.username) {
                    const username = userRaw.replace("@", "").replace(",", "");
                    const checkIfRenewed = await utils.query(`
                        SELECT *
                        FROM access_token
                        WHERE platform="spotify"
                            AND username=?
                            AND lastRenew < NOW() - interval 58 MINUTE`, [username]);

                    if (checkIfRenewed.length) {
                        try {
                            const tokenSpotify = await got(`https://accounts.spotify.com/api/token?grant_type=refresh_token&refresh_token=${await refresh("refresh_token", username)}&client_secret=${creds.client_secret_spotify}&client_id=${creds.client_id_spotify}`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/x-www-form-urlencoded"
                                },
                            }).json();

                            const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' '); // convert to sql timestamp format

                            await utils.query(`
                                UPDATE access_token
                                SET access_token=?,
                                    scopes=?,
                                    lastRenew=?
                                WHERE platform="spotify" AND username=?`,
                                [tokenSpotify.access_token, tokenSpotify.scope, timestamp, username]);

                            const checkPremium = await got(`https://api.spotify.com/v1/me`, {
                                method: "GET",
                                headers: {
                                    'Authorization': `Bearer ${await refresh("access_token", username)}`,
                                    "Content-Type": "application/x-www-form-urlencoded"
                                },
                            }).json();

                            await utils.query(`
                                UPDATE access_token
                                SET premium=?
                                WHERE platform="spotify" AND username=? AND user!="138403101"`,
                                [((checkPremium.product === "open") ? "N" : "Y"), username]);
                        } catch (err) {
                            const error = JSON.parse(err.response.body);
                            if (error.error === "invalid_grant" && error.error_description === "Refresh token revoked") {
                                await utils.query(`
                                    DELETE FROM access_token
                                    WHERE platform="spotify" AND user=?`, [username]);
                                return '';
                            }
                            console.log(err);
                        }
                    }

                    const data = await got(encodeURI(link), {
                        method: method,
                        headers: {
                            'Authorization': `Bearer ${await refresh("access_token", username)}`,
                            "Content-Type": "application/x-www-form-urlencoded"
                        },
                    }).json();

                    if (!data) {
                        return '';
                    }
                    return data;
                }
                const checkIfRenewed = await utils.query(`
                    SELECT *
                    FROM access_token
                    WHERE platform="spotify"
                        AND user=?
                        AND lastRenew < NOW() - interval 58 MINUTE`,
                    [user['user-id']]);

                if (checkIfRenewed.length) {
                    try {
                        const tokenSpotify = await got(`https://accounts.spotify.com/api/token?grant_type=refresh_token&refresh_token=${await refresh("refresh_token")}&client_secret=${creds.client_secret_spotify}&client_id=${creds.client_id_spotify}`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/x-www-form-urlencoded"
                            },
                        }).json();

                        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' '); // convert to sql timestamp format

                        await utils.query(`
                            UPDATE access_token
                            SET access_token=?,
                                scopes=?,
                                lastRenew=?
                            WHERE platform="spotify" AND user=?`,
                            [tokenSpotify.access_token, tokenSpotify.scope, timestamp, user['user-id']]);

                        const checkPremium = await got(`https://api.spotify.com/v1/me`, {
                            method: "GET",
                            headers: {
                                'Authorization': `Bearer ${await refresh("access_token")}`,
                                "Content-Type": "application/x-www-form-urlencoded"
                            },
                        }).json();

                        await utils.query(`
                            UPDATE access_token
                            SET premium=?,
                                username=?
                            WHERE platform="spotify" AND user=? AND user!="138403101"`,
                            [((checkPremium.product === "open") ? "N" : "Y"), user.username, user['user-id']]);
                    } catch (err) {
                        const error = JSON.parse(err.response.body);
                        if (error.error === "invalid_grant" && error.error_description === "Refresh token revoked") {
                            await utils.query(`
                                DELETE FROM access_token
                                WHERE platform="spotify" AND user=?`, [user['user-id']]);

                            kb.whisper(user.username, `Your Spotify token has been revoked by Spotify, you will have to register for this command again to use it. https://kunszg.com/connections`);
                            return '';
                        }
                        console.log(err);
                    }
                }

                const data = await got(encodeURI(link), {
                    method: method,
                    headers: {
                        'Authorization': `Bearer ${await refresh("access_token")}`,
                        "Content-Type": "application/x-www-form-urlencoded"
                    },
                }).json();

                if (!data) {
                    return '';
                }
                return data;
            }

            const minutes = (input) => {
                const minutes = String(Math.floor(input/1000/60));
                if (minutes.split('').length===1) {
                    return `0${minutes}`;
                }
                return minutes;
            }

            const seconds = (input) => {
                const seconds = String(Math.floor(input/1000 % 60));
                if (seconds.split('').length===1) {
                    return `0${seconds}`;
                }
                return seconds;
            }

            const getFlag = (flag) => {
                const findPrefix = msg.find(i => i.toLowerCase().startsWith("-"));
                if (findPrefix) {
                    return findPrefix.split("").find(i => i.toLowerCase() === flag);
                }
                return false;
            }

            if (msg[0]) {
                if (msg[0].startsWith("@")) {
                    this.msg = msg[0].toLowerCase().replace(/@|,/g, '');

                    if (this.msg === "nymn2" && channel === "#nymn2") {
                        if (talkedRecently.has("cooldown" + channel)) { return ""; }

                        talkedRecently.add("cooldown" + channel);

                        setTimeout(() => {
                            talkedRecently.delete("cooldown" + channel);
                        }, 8000);
                    }

                    if (this.msg === "mande" && channel === "#mande") {
                        if (talkedRecently.has("cooldown" + channel)) { return ""; }

                        talkedRecently.add("cooldown" + channel);

                        setTimeout(() => {
                            talkedRecently.delete("cooldown" + channel);
                        }, 8000);
                    }

                    if (this.msg === "nymn" && channel === "#nymn") {
                        if (talkedRecently.has("cooldown" + channel)) { return ""; }

                        talkedRecently.add("cooldown" + channel);

                        setTimeout(() => {
                            talkedRecently.delete("cooldown" + channel);
                        }, 8000);
                    }

                    const checkIfOptedOut = await utils.query(`
                        SELECT *
                        FROM optout
                        WHERE command=? AND username=?`,
                        ["spotify", this.msg]);

                    if (checkIfOptedOut.length && (user.username != this.msg)) {
                        return `${user.username}, that user has opted out from being a target of Spotify command.`;
                    }

                    const findUser = await utils.query(`
                        SELECT *
                        FROM user_list
                        WHERE username=?`,
                        [msg[0].toLowerCase().replace(/@|,/g, '')]);

                    if (!findUser.length) {
                        return `${user.username}, this user does not exist.`;
                    }

                    const isRegistered = await utils.query(`
                        SELECT *
                        FROM access_token
                        WHERE platform="spotify" AND user=?`,
                        [findUser[0].userId]);

                    if (!isRegistered.length) {
                        if (message.split(' ')[1] === "song") {
                            return lastfm.invocation(channel, user, message, "song");
                        }

                        return `${user.username}, this user is not registered for this command.`;
                    }

                    if (isRegistered[0].allowLookup === "N" && user.username != msg[0].toLowerCase().replace(/@|,/g, '')) {
                        return `${user.username}, this user's settings do not allow for a song lookup, ask them to use kb spotify allow :)`;
                    }
                    const song = await apiCall("https://api.spotify.com/v1/me/player/currently-playing", findUser[0].username);

                    if (!song) {
                        return `${user.username}, there is no song playing on ${findUser[0].username}'s Spotify.`;
                    }

                    const [artist, songTitle] = new utils.ModifyOutput([song.item.artists[0].name, song.item.name]).trimmer();

                    const response = `${user.username}, current song playing on ${findUser[0].username.replace(/^(.{2})/, "$1\u{E0000}")}'s Spotify:
                    ${songTitle} by ${artist}, ${song.is_playing ? '▶ ' : '⏸ '}
                    [${minutes(song.progress_ms)}:${seconds(song.progress_ms)}/${minutes(song.item.duration_ms)}:${seconds(song.item.duration_ms)}] `;

                    try {
                        const youtube = await utils.youtube(`${song.item.name} by ${song.item.artists[0].name}`);

                        if (!youtube) {
                            throw { error: { code: 403 } };
                        }

                        if (msg.filter(i => i === "-t").length) {
                            return response + `https://youtu.be/${youtube.id}?t=${Math.round(song.progress_ms/1000)}`;
                        }

                        return response + `https://youtu.be/${youtube.id}`;
                    } catch (err) {
                        if (err.error?.code === 403) {
                            return response + song.item.external_urls.spotify;
                        }
                        console.log(err);

                        if (msg[0]) {
                            if (msg[0].startsWith('@')) {
                                return `${user.username}, there is no song playing on ${findUser[0].username}'s Spotify.`;
                            }
                        }
                    }
                }
            }

            const userList = await utils.query(`
                SELECT *
                FROM access_token
                WHERE platform="spotify"`);

            const users = userList.map(i => i.user)

            const permittedUsers = users.filter(i => i === user['user-id']);

            if (!permittedUsers.length) {
                if (message.split(' ')[1] === "song") {
                    const _userList = await utils.query(`
                        SELECT *
                        FROM access_token
                        WHERE platform="lastfm"`);

                    const _users = _userList.map(i => i.user)

                    const _permittedUsers = _users.filter(i => i === user['user-id']);

                    if (!_permittedUsers.length) {
                        return `${user.username}, To get access to this command, follow the login process on https://kunszg.com/connections`;
                    }
                }
                else {
                    return `${user.username}, To get access to this command, follow the login process on https://kunszg.com/connections`;
                }
            }

            const premUsers = userList.filter(i => i.premium === "Y").map(i => i.user)
            const premiumUsers = premUsers.filter(i => i === user['user-id']);

            const song = await apiCall('https://api.spotify.com/v1/me/player/currently-playing', user.username, 'GET');

            if ((msg[0] === "play" || msg[0] === "queue") || (msg[0] === "p" || msg[0] === "q")) {
                try {
                    if (!msg[1]) {
                        return `${user.username}, you did not provide anything to search for FeelsDankMan`;
                    }

                    if (!premiumUsers.length) {
                        return `${user.username}, only Spotify premium users can use this parameter :(`;
                    }

                    const search = await apiCall(`https://api.spotify.com/v1/search?q=${msg.splice(1).join(' ')}&type=track`, user.username, 'GET');

                    if (!search.tracks.items.length) {
                        return `${user.username}, no tracks were found with given query.`;
                    }

                    let [playing, artist] = new utils.ModifyOutput([search.tracks.items[0].name, search.tracks.items[0].artists[0].name]).trimmer();

                    // kb queue [song]
                    if (msg[0] === "q" || msg[0] === "queue") {
                        await apiCall(`https://api.spotify.com/v1/me/player/queue?uri=${search.tracks.items[0].uri}`, user.username, 'POST');

                        return `${user.username}, ${playing} by ${artist} has been added to your playback queue.`;
                    }

                    const _user = await utils.query(`
                        SELECT *
                        FROM access_token
                        WHERE username=?`, [user.username]);

                    // kb play [song]
                    shell.execSync(`curl -s -X "PUT" "https://api.spotify.com/v1/me/player/play"` +
                                    ` --data "{\\"uris\\":[\\"${search.tracks.items[0].uri}\\"],\\"position_ms\\":0}"` +
                                    ` -H "Accept: application/json"` +
                                    ` -H "Content-Type: application/json"` +
                                    ` -H "Authorization: Bearer ${_user[0].access_token}"`);

                    return `${user.username}, now playing: ${playing} by ${artist} on your Spotify.`;
                } catch (err) {
                    console.log(err);
                    return `${user.username}, no active devices were found. You should have your spotify running while using this command.`;
                }
            }

            if (msg[0] === "top") {
                const assignNumbers = (data) => {
                    let _data = [];

                    for (let i = 0; i < data.length; i++) {
                        _data.push(`(${i + 1}) ${data[i]}`);
                    }

                    return _data;
                }

                const timeRange = msg.find(i => i.match(/\bshort\b|\bmedium\b|\blong\b/i)) ?? "long";

                const findUser = msg.find(i => i.startsWith("@"));

                if (findUser) {
                    const _user = findUser.toLowerCase().replace(/@|,/g, "");

                    const checkIfOptedOut = await utils.query(`
                        SELECT *
                        FROM optout
                        WHERE command=? AND username=?`,
                        ["spotify", _user]);

                    if (checkIfOptedOut.length && (user.username != _user)) {
                        return `${user.username}, that user has opted out from being a target of Spotify command.`;
                    }

                    const checkIfUserRegistered = await utils.query(`
                        SELECT *
                        FROM access_token
                        WHERE username=?`, [_user]);

                    if (!checkIfUserRegistered.length) {
                        if (message.split(' ')[1] === "song") {
                            return lastfm.invocation(channel, user, message, "song");
                        }

                        return `${user.username}, specified user is not registered for this command`;
                    }

                    if (checkIfUserRegistered[0].allowLookup === "N") {
                        return `${user.username}, specified user does not allow for data lookup. They can enable it by typing "kb spotify allow"`;
                    }

                    // kb spotify top artists @user
                    if (msg.find(i => i.match(/\bartist[s]?\b/i))) {
                        let topArtistData = await apiCall(`https://api.spotify.com/v1/me/top/artists?time_range=${timeRange.toLowerCase()}_term`, _user);

                        topArtistData = topArtistData.items.slice(0, 5).map(i => i.name);

                        const artists = new utils.ModifyOutput(topArtistData, 23).trimmer();

                        return `${user.username}, that user's ${timeRange} term most listened to
                        Spotify artists are: ${assignNumbers(artists).join(', ')}`
                    }

                    // kb spotify top @user
                    let topTracksData = await apiCall(`https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange.toLowerCase()}_term`, _user);

                    const songs = assignNumbers(
                        new utils.ModifyOutput(
                            topTracksData.items.slice(0, 4).map(i => i.name)
                            ).trimmer()
                        );

                    const artists = new utils.ModifyOutput(
                        topTracksData.items.slice(0, 4).map(i => i.artists[0].name)
                        ).trimmer();

                    let result = [];

                    for (let i = 0; i < songs.length; i++) {
                        result.push(`${songs[i]} by ${artists[i]}`);
                    }

                    return `${user.username}, that user's ${timeRange} term most listened to Spotify songs are: ${result.join(", ")}`;
                }

                // kb spotify top artists
                if (msg.find(i => i.match(/\bartist[s]?\b/i))) {
                    let topArtistData = await apiCall(`https://api.spotify.com/v1/me/top/artists?time_range=${timeRange.toLowerCase()}_term`);

                    topArtistData = topArtistData.items.slice(0, 5).map(i => i.name);

                    const artists = new utils.ModifyOutput(topArtistData, 23).trimmer();

                    return `${user.username}, your ${timeRange} term most listened to Spotify artists are: ${assignNumbers(artists).join(', ')}`;
                }

                // kb spotify top
                const topTracksData = await apiCall(`https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange.toLowerCase()}_term`);

                const songs = assignNumbers(
                    new utils.ModifyOutput(
                        topTracksData.items.slice(0, 4).map(i => i.name)
                        ).trimmer()
                    );

                const artists = new utils.ModifyOutput(
                    topTracksData.items.slice(0, 4).map(i => i.artists[0].name)
                    ).trimmer();

                let result = [];

                for (let i = 0; i < songs.length; i++) {
                    result.push(`${songs[i]} by ${artists[i]}`);
                }

                return `${user.username}, your ${timeRange} term most listened to Spotify songs are: ${result.join(", ")}`;
            }

            if (msg[0] === "search") {
                if (!msg[1]) {
                    return `${user.username}, you have to provide a query to search with or a track/artist, refer to https://kunszg.com/commands`;
                }

                let response, query, type = "track";

                if (getFlag("a") && getFlag("t")) {
                    return `${user.username}, only one of the flags can be used at a time.`;
                }

                if (getFlag("a")) { type = "artist"; }

                if (msg[0] === "search") {
                    query = msg.splice(1).filter(i => (i != "-a") && (i != "-t")).join(" ");
                }
                else {
                    query = msg.filter(i => (i != "-a") && (i != "-t")).join(" ");
                }

                const search = await apiCall(`https://api.spotify.com/v1/search?type=${type}&q=${query}&limit=1&offset=0`, user.username, "GET");

                if (type === "track") {
                    if (!search?.tracks ?? false) {
                        return `${user.username}, no ${type}s were found.`;
                    }

                    if (!search.tracks.items.length) {
                        return `${user.username}, no ${type}s were found.`;
                    }

                    const [track, artist, album] = new utils.ModifyOutput([
                            search.tracks.items[0].name,
                            search.tracks.items[0].artists[0].name,
                            search.tracks.items[0].album.name
                        ]).trimmer();

                    const trackId = Math.trunc(Math.random() * 9999);

                    searchCache.push({
                        "id": trackId,
                        "uri": search.tracks.items[0].uri,
                        "user": user.username,
                        "track": track,
                        "artist": artist
                    });

                    if (search.tracks.total > 1) {
                        type = "songs"
                    }

                    const result = `${user.username}, found ${search.tracks.total} ${type},
                    closest matching one is ${track} by ${artist} from album ${album} `;

                    try {
                        const youtube = await utils.youtube(`${track} by ${artist}`);

                        if (!youtube) {
                            throw { error: { code: 403 } };
                        }

                        return result + `https://youtu.be/${youtube.id}
                        - you can play it on your spotify by using kb yoink ${trackId}`;
                    } catch (err) {
                        if (err.error?.code === 403) {
                            return result + search.tracks.items[0].external_urls.spotify +
                            ` - you can play it on your spotify by using kb yoink ${trackId}`;
                        }
                    }
                }

                if (type === "artist") {
                    if (!search?.artists ?? false) {
                        return `${user.username}, no ${type}s were found.`;
                    }

                    if (!search.artists.items.length) {
                        return `${user.username}, no ${type}s were found.`;
                    }

                    const [artist] = new utils.ModifyOutput([search.artists.items[0].name]).trimmer();

                    if (search.artists.total > 1) {
                        type = "artists"
                    }

                    return `${user.username}, found ${search.artists.total} ${type},
                    closest matching is ${artist} with ${search.artists.items[0].followers.total} followers
                    ${search.artists.items[0].external_urls.spotify}`;
                }
            }

            if (msg[0] === "yoink") {
                if (!msg[1]) {
                    return `${user.username}, you did not provide a user to search for FeelsDankMan`;
                }

                if (!premiumUsers.length) {
                    return `${user.username}, only Spotify premium users can use this parameter :(`;
                }

                const checkCache = searchCache.find(i => i.id.toString() === msg[1]);

                if (checkCache) {
                    try {
                        let playback = "is now playing on your device"

                        if (getFlag("q")) {
                            await apiCall(`https://api.spotify.com/v1/me/player/queue?uri=${checkCache.uri}`, user.username, 'POST');

                            playback = "has been added to your playback queue"
                        }
                        else {
                            const _token = await utils.query(`
                                SELECT *
                                FROM access_token
                                WHERE username=?`, [user.username]);

                            shell.execSync(`curl -s -X "PUT" "https://api.spotify.com/v1/me/player/play"` +
                                            ` --data "{\\"uris\\":[\\"${checkCache.uri}\\"],\\"position_ms\\":0}"` +
                                            ` -H "Accept: application/json"` +
                                            ` -H "Content-Type: application/json"` +
                                            ` -H "Authorization: Bearer ${_token[0].access_token}"`);
                        }

                        const [playing, artist] = new utils.ModifyOutput([checkCache.track, checkCache.artist]).trimmer();

                        return `${user.username}, (request #${checkCache.id}) ${playing} by ${artist} from ${checkCache.user}'s search query
                        ${playback} PermaSmug 🎶`;
                    }
                    catch (err) {
                        return `${user.username}, your spotify needs to be playing to execute this command FeelsDankMan`;
                    }
                }

                const username = msg[1].replace(/@|,/g, "");

                if (username === user.username) {
                    return `${user.username}, why are you trying to yoink your own song FeelsDankMan`;
                }

                try {
                    const _user = await utils.query(`
                        SELECT *
                        FROM access_token
                        WHERE username=?`, [username]);

                    if (!_user.length) {
                        return `${user.username}, provided user is not registered for this command.`;
                    }

                    if (_user[0].allowLookup === "N") {
                        return `${user.username}, provided user does not consent for data lookup. They can use " kb spotify allow " to allow it. `;
                    }

                    const yoinkedSong = await apiCall("https://api.spotify.com/v1/me/player/currently-playing", username);

                    await apiCall("https://api.spotify.com/v1/me/player/currently-playing", user.username, "GET");

                    if (!yoinkedSong) {
                        return `${user.username}, there is no song playing on ${username}'s Spotify.`;
                    }

                    let position = 0;
                    let timestampMessage = "";
                    let playback = "is now playing on your device"

                    if (getFlag("t")) {
                        position = yoinkedSong.progress_ms;

                        timestampMessage = ` at timestamp [${minutes(yoinkedSong.progress_ms)}:${seconds(yoinkedSong.progress_ms)}/
                        ${minutes(yoinkedSong.item.duration_ms)}:${seconds(yoinkedSong.item.duration_ms)}]`;
                    }

                    if (getFlag("q")) {
                        await apiCall(`https://api.spotify.com/v1/me/player/queue?uri=${yoinkedSong.item.uri}`, user.username, 'POST');

                        playback = "has been added to your playback queue"
                    }
                    else {
                        const _token = await utils.query(`
                            SELECT *
                            FROM access_token
                            WHERE username=?`, [user.username]);

                        shell.execSync(`curl -s -X "PUT" "https://api.spotify.com/v1/me/player/play"` +
                                        ` --data "{\\"uris\\":[\\"${yoinkedSong.item.uri}\\"],\\"position_ms\\":${position}}"` +
                                        ` -H "Accept: application/json"` +
                                        ` -H "Content-Type: application/json"` +
                                        ` -H "Authorization: Bearer ${_token[0].access_token}"`);
                    }

                    const [playing, artist] = new utils.ModifyOutput([yoinkedSong.item.name, yoinkedSong.item.artists[0].name]).trimmer();

                    return `${user.username}, ${playing} by ${artist} from ${username.replace(/^(.{2})/, "$1\u{E0000}")}'s
                    Spotify ${playback}${timestampMessage} TriHard 🎶`;
                }
                catch (err) {
                    if (msg[0]) {
                        if (msg[0].startsWith('@')) {
                            return `${user.username}, there is no song playing on ${username}'s Spotify.`;
                        }
                    }
                    return `${user.username}, your spotify needs to be playing to execute this command FeelsDankMan`;
                }
            }

            if (message.split(' ')[2] === "unregister") {
                const checkIfUserRegistered = await utils.query(`
                    SELECT *
                    FROM access_token
                    WHERE platform="spotify" AND user=?`,
                    [user['user-id']]);

                if (!checkIfUserRegistered.length) {
                    return `${user.username}, you are not registered for this command.`;
                }

                await utils.query(`
                    DELETE FROM access_token
                    WHERE user=? AND platform="spotify"`,
                    [user['user-id']]);

                return `${user.username}, you have been successfully unregistered from Spotify command.`;
            }

            if (msg[0] === "start") {
                if (!premiumUsers.length) {
                    return `${user.username}, only Spotify premium users can use this parameter :(`;
                }

                await apiCall('https://api.spotify.com/v1/me/player/play', user.username, 'PUT');

                if (utils.strictChannels(channel)) {
                    kb.whisper(user.username, 'Current song has been resumed.');
                    return '';
                }
                return `${user.username}, current song has been resumed.`;
            }

            if (msg[0] === "pause" || msg[0] === "stop") {
                if (!premiumUsers.length) {
                    return `${user.username}, only Spotify premium users can use this parameter :(`;
                }
                if (!song?.item) {
                    return `${user.username}, no song is currently playing on your spotify FeelsDankMan`;
                }

                await apiCall('https://api.spotify.com/v1/me/player/pause', user.username, 'PUT');

                if (utils.strictChannels(channel)) {
                    kb.whisper(user.username, 'Current song has been stopped.');
                    return '';
                }
                return `${user.username}, current song has been stopped.`;
            }

            if (msg[0] === "volume" || msg[0] === "vol") {
                if (!premiumUsers.length) {
                    return `${user.username}, only Spotify premium users can use this parameter :(`;
                }

                const playback = await apiCall("https://api.spotify.com/v1/me/player", user.username);

                if (!msg[1]) {
                    if (utils.strictChannels(channel)) {
                        kb.whisper(user.username, `Current volume on your spotify is ${playback.device.volume_percent}%.`);
                        return '';
                    }
                    return `${user.username}, Current volume on your spotify is ${playback.device.volume_percent}%.`;
                }

                this.msg = msg[1].replace('%', '');

                if (!utils.hasNumber(this.msg)) {
                    return `${user.username}, only numbers within range of 0-100 are accepted.`;
                }

                if (this.msg > 100 || this.msg < 0) {
                    return `${user.username}, only numbers within range of 0-100 are accepted.`;
                }

                await apiCall(`https://api.spotify.com/v1/me/player/volume?volume_percent=${this.msg}`, user.username, 'PUT');

                if (utils.strictChannels(channel)) {
                    kb.whisper(user.username, `Volume on your spotify has been changed from ${playback.device.volume_percent}% to ${this.msg}%.`);
                    return '';
                }
                return `${user.username}, volume on your spotify has been changed from ${playback.device.volume_percent}% to ${this.msg}%.`;
            }

            if (msg[0] === "skip") {
                if (!premiumUsers.length) {
                    return `${user.username}, only Spotify premium users can use this parameter :(`;
                }
                if (!song?.item) {
                    return `${user.username}, no song is currently playing on your spotify FeelsDankMan`;
                }

                await apiCall('https://api.spotify.com/v1/me/player/next', user.username, 'POST');

                if (utils.strictChannels(channel)) {
                    kb.whisper(user.username, 'Current song has been successfully skipped.');
                    return '';
                }
                return `${user.username}, current song has been successfully skipped.`;
            }

            if (msg[0] === "shuffle" || msg[0] === "random") {
                if (!premiumUsers.length) {
                    return `${user.username}, only Spotify premium users can use this parameter :(`;
                }

                if (msg[1] === "true" || msg[1] === "on") {
                    await apiCall('https://api.spotify.com/v1/me/player/shuffle?state=true', user.username, 'PUT');

                    if (utils.strictChannels(channel)) {
                        kb.whisper(user.username, 'Your playback mode is now set to shuffle.');
                        return '';
                    }
                    return `${user.username}, your playback mode is now set to shuffle.`;
                }

                if (msg[1] === "false" || msg[1] === "off") {
                    await apiCall('https://api.spotify.com/v1/me/player/shuffle?state=false', user.username, 'PUT');

                    if (utils.strictChannels(channel)) {
                        kb.whisper(user.username, 'Your playback is not shuffled anymore.');
                        return '';
                    }
                    return `${user.username}, your playback is not shuffled anymore.`;
                }
                return `${user.username}, only parameters true/false (or on/off) are valid for trigger "shuffle"`;
            }

            if (msg[0] === "repeat") {
                if (!premiumUsers.length) {
                    return `${user.username}, only Spotify premium users can use this parameter :(`;
                }

                if (msg[1] === "track") {
                    await apiCall('https://api.spotify.com/v1/me/player/repeat?state=track', user.username, 'PUT');

                    if (utils.strictChannels(channel)) {
                        kb.whisper(user.username, 'Repeat mode on your spotify is now set to repeat current track.');
                        return '';
                    }
                    return `${user.username}, repeat mode on your spotify is now set to repeat current track.`;
                }

                if (msg[1] === "context") {
                    await apiCall('https://api.spotify.com/v1/me/player/repeat?state=context', user.username, 'PUT');

                    if (utils.strictChannels(channel)) {
                        kb.whisper(user.username, 'Repeat mode on your spotify is now set to repeat current context.');
                        return '';
                    }
                    return `${user.username}, repeat mode on your spotify is now set to repeat current context.`;
                }

                if (msg[1] === "off" || msg[1] === "false") {
                    await apiCall('https://api.spotify.com/v1/me/player/repeat?state=off', user.username, 'PUT');

                    if (utils.strictChannels(channel)) {
                        kb.whisper(user.username, 'Repeat mode on your Spotify is now turned off.');
                        return '';
                    }
                    return `${user.username}, repeat mode on your Spotify is now turned off.`;
                }

                return `${user.username}, only parameters track/context/off are valid for trigger "repeat".`;
            }

            if (msg[0] === "allow") {
                await utils.query(`
                    UPDATE access_token
                    SET allowLookup="Y"
                    WHERE platform="spotify" AND user=?`,
                    [user['user-id']]);

                return `${user.username}, you allowed other registered users to lookup your playing songs.`;
            }

            if (msg[0] === "disallow") {
                await utils.query(`
                    UPDATE access_token
                    SET allowLookup="N"
                    WHERE platform="spotify" AND user=?`,
                    [user['user-id']]);

                return `${user.username}, other users won't be able to view your currently playing song anymore.`;
            }

            if (!song?.item ?? true) {
                if (message.split(' ')[1] === "song") {
                    return lastfm.invocation(channel, user, message, "song");
                }

                return `${user.username}, no song is currently playing on your spotify FeelsDankMan`;
            }

            const [artist, songTitle] = new utils.ModifyOutput([song.item.artists[0].name, song.item.name]).trimmer();

            const response = `Current song playing on ${user.username}'s Spotify: ${songTitle} by ${artist}, ${song.is_playing ? '▶ ' : '⏸ '}` +
            `[${minutes(song.progress_ms)}:${seconds(song.progress_ms)}/${minutes(song.item.duration_ms)}:${seconds(song.item.duration_ms)}] `;

            try {
                const youtube = await utils.youtube(`${song.item.name} by ${song.item.artists[0].name}`);

                if (!youtube) {
                    throw { error: { code: 403 } };
                }

                if (msg.filter(i => i === "-t").length) {
                    return response + `https://youtu.be/${youtube.id}?t=${Math.round(song.progress_ms/1000)}`;
                }

                return response + `https://youtu.be/${youtube.id}`;
            } catch (err) {
                if (err.error?.code === 403) {
                    return response + song.item.external_urls.spotify;
                }

                if (message.split(' ')[1] === "song") {
                    return lastfm.invocation(channel, user, message, "song");
                }

                console.log(err)
                return `${user.username}, no song is currently playing on your spotify FeelsDankMan`;
            }
        } catch (err) {
            if (err.response?.statusCode) {
                return `${user.username}, ${utils.status(err.response.statusCode)} FeelsDankMan`;
            }

            if (message.split(' ')[1] === "song") {
                return lastfm.invocation(channel, user, message, "song");
            }

            console.log(err)
            return `${user.username}, no song is currently playing on your spotify FeelsDankMan`;
        }
    }
}

const constants = require("../constants");

const random = require('../helperFuncs').random;

const MINUTE = 60*1000;
const DAY = 24*60*MINUTE;
const LIMIT = 40000;



//This is a quadruplicate code, but maybe it doesn't have to be?
function getShow(program) {
    //used for equalize and frequency tweak
    if (program.isOffline) {
        if (program.type == 'redirect') {
            return {
                description : `Redirect to channel ${program.channel}`,
                id: "redirect." + program.channel,
                channel: program.channel,
            }
        } else {
            return null;
        }
    } else if ( (program.type == 'episode') && ( typeof(program.showTitle) !== 'undefined' ) ) {
        return {
            description: program.showTitle,
            id: "tv." + program.showTitle,
        }
    } else {
        return {
            description: "Movies",
            id: "movie.",
        }
    }
}


function shuffle(array, lo, hi ) {
    if (typeof(lo) === 'undefined') {
        lo = 0;
        hi = array.length;
    }
    let currentIndex = hi, temporaryValue, randomIndex
    while (lo !== currentIndex) {
        randomIndex =  random.integer(lo, currentIndex-1);
        currentIndex -= 1
        temporaryValue = array[currentIndex]
        array[currentIndex] = array[randomIndex]
        array[randomIndex] = temporaryValue
    }
    return array
}

function _wait(t) {
    return new Promise((resolve) => {
      setTimeout(resolve, t);
    });
}

function getProgramId(program) {
    let s = program.serverKey;
    if (typeof(s) === 'undefined') {
        s = 'unknown';
    }
    let p = program.key;
    if (typeof(p) === 'undefined') {
        p = 'unknown';
    }
    return s + "|" + p;
}

function addProgramToShow(show, program) {
    if ( (show.id == 'flex.') || show.id.startsWith("redirect.")  ) {
        //nothing to do
        return;
    }
    let id = getProgramId(program)
    if(show.programs[id] !== true) {
        show.programs.push(program);
        show.programs[id] = true
    }
}

function getShowOrderer(show) {
    if (typeof(show.orderer) === 'undefined') {

        let sortedPrograms = JSON.parse( JSON.stringify(show.programs) );
        sortedPrograms.sort((a, b) => {
            if (a.season === b.season) {
                if (a.episode > b.episode) {
                    return 1
                } else {
                    return -1
                }
            } else if (a.season > b.season) {
                return 1;
            } else if (b.season > a.season) {
                return -1;
            } else {
                return 0
            }
        });

        let position = 0;
        while (
            (position + 1 < sortedPrograms.length )
            &&
            (
                show.founder.season !== sortedPrograms[position].season
                ||
                show.founder.episode !== sortedPrograms[position].episode
            )
        ) {
            position++;
        }


        show.orderer = {

            current : () => {
                return sortedPrograms[position];
            },

            next: () => {
                position = (position + 1) % sortedPrograms.length;
            },

        }
    }
    return show.orderer;
}


function getShowShuffler(show) {
    if (typeof(show.shuffler) === 'undefined') {
        if (typeof(show.programs) === 'undefined') {
            throw Error(show.id + " has no programs?")
        }

        let randomPrograms = JSON.parse( JSON.stringify(show.programs) );
        let n = randomPrograms.length;
        shuffle( randomPrograms, 0, n);
        let position = 0;

        show.shuffler  = {

            current : () => {
                return randomPrograms[position];
            },

            next: () => {
                position++;
                if (position == n) {
                    let a = Math.floor(n / 2);
                    shuffle(randomPrograms, 0, a );
                    shuffle(randomPrograms, a, n );
                    position = 0;
                }
            },

        }
    }
    return show.shuffler;
}

module.exports = async( programs, schedule  ) => {
    if (! Array.isArray(programs) ) {
        return { userError: 'Expected a programs array' };
    }
    if (typeof(schedule) === 'undefined') {
        return { userError: 'Expected a schedule' };
    }
    //verify that the schedule is in the correct format
    if (! Array.isArray(schedule.slots) ) {
        return { userError: 'Expected a "slots" array in schedule' };
    }
    if (typeof(schedule).period === 'undefined') {
        schedule.period = DAY;
    }
    for (let i = 0; i < schedule.slots.length; i++) {
        if (typeof(schedule.slots[i].duration) === 'undefined') {
            return { userError: "Each slot should have a duration" };
        }
        if (typeof(schedule.slots[i].showId) === 'undefined') {
            return { userError: "Each slot should have a showId" };
        }
        if (
            (schedule.slots[i].duration <= 0)
            || (Math.floor(schedule.slots[i].duration) != schedule.slots[i].duration)
        ) {
            return { userError: "Slot duration should be a integer number of milliseconds greater than 0" };
        }
        if ( isNaN(schedule.slots[i].cooldown)  ) {
            schedule.slots[i].cooldown = 0;
        }
        if ( isNaN(schedule.slots[i].weight)  ) {
            schedule.slots[i].weight = 1;
        }
    }
    if (typeof(schedule.pad) === 'undefined') {
        return { userError: "Expected schedule.pad" };
    }
    if (typeof(schedule.maxDays) == 'undefined') {
        return { userError: "schedule.maxDays must be defined." };
    }
    if (typeof(schedule.flexPreference) === 'undefined') {
        schedule.flexPreference = "distribute";
    }
    if (typeof(schedule.padStyle) === 'undefined') {
        schedule.padStyle = "slot";
    }
    if (schedule.padStyle !== "slot" && schedule.padStyle !== "episode") {
        return { userError: `Invalid schedule.padStyle value: "${schedule.padStyle}"` };
    }
    let flexBetween = ( schedule.flexPreference !== "end" );

    // throttle so that the stream is not affected negatively
    let steps = 0;
    let throttle = async() => {
        if (steps++ == 10) {
            steps = 0;
            await _wait(1);
        }
    }

    let showsById = {};
    let shows = [];

    function getNextForSlot(slot, remaining) {
        //remaining doesn't restrict what next show is picked. It is only used
        //for shows with flexible length (flex and redirects)
        if (slot.showId === "flex.") {
            return {
                isOffline: true,
                duration: remaining,
            }
        }
        let show = shows[ showsById[slot.showId] ];
        if (slot.showId.startsWith("redirect.")) {
            return {
                isOffline: true,
                type: "redirect",
                duration: remaining,
                channel: show.channel,
            }
        } else if (slot.order === 'shuffle') {
            return getShowShuffler(show).current();
        } else if (slot.order === 'next') {
            return getShowOrderer(show).current();
        }
    }
    
    function advanceSlot(slot) {
        if ( (slot.showId === "flex.") || (slot.showId.startsWith("redirect") ) ) {
            return;
        }
        let show = shows[ showsById[slot.showId] ];
        if (slot.order === 'shuffle') {
            return getShowShuffler(show).next();
        } else if (slot.order === 'next') {
            return getShowOrderer(show).next();
        }
    }

    function makePadded(item) {
        let padOption = schedule.pad;
        if (schedule.padStyle === "slot") {
            padOption = 1;
        }
        let x = item.duration;
        let m = x % padOption;
        let f = 0;
        if ( (m > constants.SLACK) && (padOption - m > constants.SLACK) ) {
            f = padOption - m;
        }
        return {
            item: item,
            pad: f,
            totalDuration: item.duration + f,
        }

    }

    // load the programs
    for (let i = 0; i < programs.length; i++) {
        let p = programs[i];
        let show = getShow(p);
        if (show != null) {
            if (typeof(showsById[show.id] ) === 'undefined') {
                showsById[show.id] = shows.length;
                shows.push( show );
                show.founder = p;
                show.programs = [];
            } else {
                show = shows[ showsById[show.id] ];
            }
            addProgramToShow( show, p );
        }
    }

    let s = schedule.slots;
    let ts = (new Date() ).getTime();
    let curr = ts - ts % DAY;
    let t0 = ts;
    let p = [];
    let t = t0;
    let wantedFinish = 0;
    let hardLimit = t0 + schedule.maxDays * DAY;

    let pushFlex = (d) => {
        if (d > 0) {
            t += d;
            if ( (p.length > 0) && p[p.length-1].isOffline && (p[p.length-1].type != 'redirect') ) {
                p[p.length-1].duration += d;
            } else {
                p.push( {
                    duration: d,
                    isOffline : true,
                } );
            }
        }
    }

    let slotLastPlayed = {};

    while ( (t < hardLimit) && (p.length < LIMIT) ) {
        await throttle();
        //ensure t is padded
        let m = t % schedule.pad;
        if ( (t % schedule.pad > constants.SLACK) && (schedule.pad - m > constants.SLACK) )  {
            pushFlex( schedule.pad - m );
            continue;
        }

        let slot = null;
        let slotIndex = null;
        let remaining = null;

        let n = 0;
        let minNextTime = t + 24*DAY;
        for (let i = 0; i < s.length; i++) {
            if ( typeof( slotLastPlayed[i] ) !== undefined ) {
                let lastt = slotLastPlayed[i];
                minNextTime = Math.min( minNextTime, lastt + s[i].cooldown );
                if (t - lastt < s[i].cooldown - constants.SLACK ) {
                    continue;
                }
            }
            n += s[i].weight;
            if ( random.bool(s[i].weight,n) ) {
                slot = s[i];
                slotIndex = i;
                remaining = s[i].duration;
            }
        }
        if (slot == null) {
            //Nothing to play, likely due to cooldown
            pushFlex( minNextTime - t);
            continue;
        }
        let item = getNextForSlot(slot, remaining);

        if (item.isOffline) {
            //flex or redirect. We can just use the whole duration
            p.push(item);
            t += remaining;
            slotLastPlayed[ slotIndex ] = t;
            continue;
        }
        if (item.duration > remaining) {
            // Slide
            p.push(item);
            t += item.duration;
            slotLastPlayed[ slotIndex ] = t;
            advanceSlot(slot);
            continue;
        }

        let padded = makePadded(item);
        let total = padded.totalDuration;
        advanceSlot(slot);
        let pads = [ padded ];

        while(true) {
            let item2 = getNextForSlot(slot);
            if (total + item2.duration > remaining) {
                break;
            }
            let padded2 = makePadded(item2);
            pads.push(padded2);
            advanceSlot(slot);
            total += padded2.totalDuration;
        }
        let temt = t + total;
        let rem = 0;
        if (
            (temt % schedule.pad >= constants.SLACK)
            && (temt % schedule.pad < schedule.pad - constants.SLACK)
        ) {
            rem = schedule.pad - temt % schedule.pad;
        }
        

        if (flexBetween && (schedule.padStyle === 'episode') ) {
            let div = Math.floor(rem / schedule.pad );
            let mod = rem % schedule.pad;
            // add mod to the latest item
            pads[ pads.length - 1].pad += mod;
            pads[ pads.length - 1].totalDuration += mod;

            let sortedPads = pads.map( (p, $index) => {
                return {
                    pad: p.pad,
                    index : $index,
                }
            });
            sortedPads.sort( (a,b) => { return a.pad - b.pad; } );
            for (let i = 0; i < pads.length; i++) {
                let q = Math.floor( div / pads.length );
                if (i < div % pads.length) {
                    q++;
                }
                let j = sortedPads[i].index;
                pads[j].pad += q * schedule.pad;
            }
        } else if (flexBetween) {
            //just distribute it equitatively
            let div = rem / pads.length;
            for (let i = 0; i < pads.length; i++) {
                pads[i].pad += div;
            }
        } else {
            //also add div to the latest item
            pads[ pads.length - 1].pad += rem;
            pads[ pads.length - 1].totalDuration += rem;
        }
        // now unroll them all
        for (let i = 0; i < pads.length; i++) {
            p.push( pads[i].item );
            t += pads[i].item.duration;
            slotLastPlayed[ slotIndex ] = t;
            pushFlex( pads[i].pad );
        }
    }
    while ( (t > hardLimit) || (p.length >= LIMIT) ) {
        t -= p.pop().duration;
    }
    let m = t % schedule.period;
    let rem = 0;
    if (m > wantedFinish) {
        rem = schedule.period + wantedFinish - m;
    } else if (m < wantedFinish) {
        rem = wantedFinish - m;
    }
    if (rem > constants.SLACK) {
        pushFlex(rem);
    }


    return {
        programs: p,
        startTime: (new Date(t0)).toISOString(),
    }

}





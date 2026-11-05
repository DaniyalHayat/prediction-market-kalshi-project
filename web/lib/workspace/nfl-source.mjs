const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ET_DAY = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'});
const names = [
  ['ARI', 'Arizona Cardinals', 'Arizona', 'AZ', 'ARZ'], ['ATL', 'Atlanta Falcons', 'Atlanta'],
  ['BAL', 'Baltimore Ravens', 'Baltimore'], ['BUF', 'Buffalo Bills', 'Buffalo'],
  ['CAR', 'Carolina Panthers', 'Carolina'], ['CHI', 'Chicago Bears', 'Chicago'],
  ['CIN', 'Cincinnati Bengals', 'Cincinnati'], ['CLE', 'Cleveland Browns', 'Cleveland'],
  ['DAL', 'Dallas Cowboys', 'Dallas'], ['DEN', 'Denver Broncos', 'Denver'],
  ['DET', 'Detroit Lions', 'Detroit'], ['GB', 'Green Bay Packers', 'Green Bay'],
  ['HOU', 'Houston Texans', 'Houston'], ['IND', 'Indianapolis Colts', 'Indianapolis'],
  ['JAC', 'Jacksonville Jaguars', 'Jacksonville', 'JAX'], ['KC', 'Kansas City Chiefs', 'Kansas City'],
  ['LV', 'Las Vegas Raiders', 'Las Vegas'], ['LAC', 'Los Angeles Chargers', 'Los Angeles C', 'LA Chargers'],
  ['LAR', 'Los Angeles Rams', 'Los Angeles R', 'LA Rams'], ['MIA', 'Miami Dolphins', 'Miami'],
  ['MIN', 'Minnesota Vikings', 'Minnesota'], ['NE', 'New England Patriots', 'New England'],
  ['NO', 'New Orleans Saints', 'New Orleans'], ['NYG', 'New York Giants', 'New York G', 'NY Giants'],
  ['NYJ', 'New York Jets', 'New York J', 'NY Jets'], ['PHI', 'Philadelphia Eagles', 'Philadelphia'],
  ['PIT', 'Pittsburgh Steelers', 'Pittsburgh'], ['SF', 'San Francisco 49ers', 'San Francisco'],
  ['SEA', 'Seattle Seahawks', 'Seattle'], ['TB', 'Tampa Bay Buccaneers', 'Tampa Bay'],
  ['TEN', 'Tennessee Titans', 'Tennessee'], ['WAS', 'Washington Commanders', 'Washington', 'WSH']
];
const clean = value => String(value ?? '').trim().toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ');
const teams = new Map(names.map(([code, name]) => [code, {name, slug: name.split(' ').at(-1).toLowerCase()}]));
const aliases = new Map(names.flatMap(([code, name, ...others]) =>
  [code, name, name.split(' ').at(-1), ...others].map(alias => [clean(alias), code])));
const codeOf = value => aliases.get(clean(value)) ?? null;

export const nflSeasonScoreboardURL = year => ESPN + '?dates=' + year + '&seasontype=2&limit=1000';
export const nflDateScoreboardURL = date => ESPN + '?dates=' + date.replaceAll('-', '');

function checkedDate(year, month, day) {
  const index = MONTHS.indexOf(month.toUpperCase());
  if (index < 0) return null;
  const date = new Date(Date.UTC(year, index, day));
  return date.getUTCMonth() === index && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

export function nflContractIdentity(market) {
  const unavailable = reason => ({available: false, reason});
  const ticker = /^KXNFLGAME-(\d{2})([A-Z]{3})(\d{2})([A-Z]{4,6})-([A-Z]{2,3})$/.exec(market?.ticker);
  if (!ticker || market.event_ticker !== market.ticker.slice(0, market.ticker.lastIndexOf('-'))) {
    return unavailable('The NFL contract ticker and event identity did not match.');
  }
  const rule = /^If (.+?) wins the (.+?) vs (.+?) Pro Football game originally scheduled for ([A-Za-z]{3}) (\d{1,2}), (20\d{2}), then the market resolves to Yes\.$/i.exec(String(market.rules_primary ?? '').trim());
  if (!rule) return unavailable('The contract does not establish a named NFL game winner.');
  const [, winner, first, second, ruleMonth, ruleDay, ruleYear] = rule;
  const date = checkedDate(2000 + Number(ticker[1]), ticker[2], Number(ticker[3]));
  const ruleDate = checkedDate(Number(ruleYear), ruleMonth, Number(ruleDay));
  const a = codeOf(first), b = codeOf(second), yes = codeOf(winner);
  const title = /^(.+?) wins$/i.exec(String(market.title ?? '').trim());
  if (!date || date !== ruleDate || !a || !b || a === b || ![a, b].includes(yes) ||
      ticker[4] !== a + b || codeOf(ticker[5]) !== yes || codeOf(market.yes_sub_title) !== yes ||
      !title || codeOf(title[1]) !== yes) {
    return unavailable('The NFL teams, YES side, title or original date were inconsistent.');
  }
  const tiePayoutVerified = /If the game ends in a tie, the market will resolve to \$0\.50 for each team\./i.test(market.rules_secondary);
  return {
    available: true,
    date,
    event_ticker: market.event_ticker,
    team_codes: [a, b],
    yes_code: yes,
    team_names: [teams.get(a).name, teams.get(b).name],
    yes_name: teams.get(yes).name,
    tie_payout_verified: tiePayoutVerified
  };
}

function validTeam(competitor) {
  const code = codeOf(competitor?.team?.abbreviation);
  return code && codeOf(competitor.team.displayName) === code ? code : null;
}

function validScore(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (!/^\d+$/.test(String(raw))) return null;
  const value = Number(raw);
  return value <= 100 ? value : null;
}

export function parseNFLScoreboard(payload) {
  if (!payload?.leagues?.some(league => league.slug === 'nfl') || !Array.isArray(payload.events) || payload.events.length > 1000) {
    throw new Error('NFL scoreboard identity or event coverage is unavailable.');
  }
  const games = [], rejected = [];
  for (const event of payload.events) {
    if (event.season?.type !== 2) continue;
    const competition = event.competitions?.length === 1 ? event.competitions[0] : null;
    const home = competition?.competitors?.find(team => team.homeAway === 'home');
    const away = competition?.competitors?.find(team => team.homeAway === 'away');
    const status = competition?.status?.type;
    const kickoff = Date.parse(event.date);
    const completed = status?.completed === true && status?.state === 'post' && /^STATUS_FINAL/.test(status?.name || '');
    const homeCode = validTeam(home), awayCode = validTeam(away);
    const homeScore = validScore(home?.score), awayScore = validScore(away?.score);
    if (!/^\d+$/.test(event.id) || String(competition?.id) !== String(event.id) ||
        competition?.competitors?.length !== 2 || !homeCode || !awayCode || homeCode === awayCode ||
        !/^\d+$/.test(home.team.id) || !/^\d+$/.test(away.team.id) ||
        !Number.isFinite(kickoff) || !Number.isInteger(event.season.year) ||
        !Number.isInteger(event.week?.number) || event.week.number < 1 || event.week.number > 18 ||
        typeof competition.neutralSite !== 'boolean' || !status?.state ||
        (status?.completed === true && !completed) || (completed && (homeScore === null || awayScore === null))) {
      rejected.push(String(event.id ?? 'unknown'));
      continue;
    }
    const game = {
      id: String(event.id), league: 'nfl', played_at: new Date(kickoff).toISOString(),
      season: event.season.year, week: event.week.number, neutral: competition.neutralSite,
      home_id: homeCode, away_id: awayCode, home_code: homeCode, away_code: awayCode,
      home_espn_id: String(home.team.id), away_espn_id: String(away.team.id),
      home_name: teams.get(homeCode).name, away_name: teams.get(awayCode).name,
      home_score: completed ? homeScore : null, away_score: completed ? awayScore : null,
      completed, state: status.state, status_name: status.name,
      nfl_game_url: 'https://www.nfl.com/games/' + teams.get(awayCode).slug + '-at-' + teams.get(homeCode).slug +
        '-' + event.season.year + '-reg-' + event.week.number
    };
    games.push(game);
  }
  return {games, rejected};
}

export function matchNFLFixture(identity, games) {
  if (!identity.available) return {reason: identity.reason};
  const [a, b] = identity.team_codes;
  const matches = games.filter(game => ET_DAY.format(new Date(game.played_at)) === identity.date &&
    game.away_code === a && game.home_code === b);
  if (matches.length !== 1) return {reason: 'The exact dated NFL fixture and home/away teams were unavailable.'};
  const game = matches[0];
  return {game, side: identity.yes_code === game.home_code ? 'home' : 'away'};
}

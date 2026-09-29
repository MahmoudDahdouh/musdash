/**
 * Words for automatic hostnames: `<adjective>-<noun>.<base>` (D66).
 *
 * Vendored rather than a dependency — two short arrays cost less than any
 * package's resident memory. Lowercase a–z only, at most eight letters, so a
 * label is always a valid DNS label well under 63 bytes. Plain, neutral and
 * hard to misread aloud: no words that change meaning with a typo, nothing
 * that could embarrass someone whose app it names.
 *
 * One string per list, split once at load, so the formatter keeps them compact.
 * 128 × 128 = 16,384 pairs. A collision is retried and then suffixed, so the
 * lists only need to make one unlikely, not impossible.
 */

function list(text: string): readonly string[] {
  return Object.freeze(text.trim().split(/\s+/))
}

export const ADJECTIVES = list(`
  able agile amber ample azure basic bold brave breezy bright
  brisk calm candid cheery chief civic clean clear clever cosmic
  cozy crisp curly daring dapper deft direct dreamy eager early
  easy elated epic exact fair fancy fast fine firm fleet
  fluffy fresh frosty gentle giant glad golden grand green handy
  happy hardy hazel honest humble ideal indigo jolly jovial keen
  kind large lively loyal lucid lucky lunar magic major mellow
  merry mighty misty modern nimble noble novel olive open patient
  peppy plucky polar polite prime proud quick quiet rapid rare
  ready regal robust rosy royal rustic sandy shiny silent silver
  simple sleek smart smooth snowy solar solid sonic spry steady
  stellar sturdy sunny super swift tidy tranquil true trusty upbeat
  urban valiant vast vivid warm wise witty zesty
`)

export const NOUNS = list(`
  acorn anchor apple arrow aspen badger bamboo beacon beaver birch
  bison breeze brook canyon cedar cheetah cliff cloud clover comet
  condor coral cougar crane creek cricket dolphin dove eagle ember
  falcon fern finch fjord forest fox galaxy gecko glacier grove
  harbor hawk heron hill horizon island jaguar koala lagoon lake
  lantern lark leaf lemur lion lotus lynx maple meadow meteor
  mint moon moose nebula nectar oak ocean orbit orca osprey
  otter owl panda panther parrot pebble pelican penguin pine planet
  plum pond prairie puffin quail quartz rabbit raven reef ridge
  river robin rocket sail salmon sequoia shore sparrow spruce star
  stone stream summit swan thistle thunder tiger trail tulip tundra
  valley violet walrus wave willow wolf wren yak zebra zephyr
  badge bay cove dune field gale mesa peak
`)

module.exports = grammar({
  name: 'haikuscript',

  // Ignore spaces, tabs, and commas, but keep newlines strictly structural
  extras: $ => [/[ \t\r,]+/], 

  rules: {
    // A program is a repetition of stanzas OR random blank lines
    program: $ => repeat(choice($.stanza, $.newline)),

    // A stanza is exactly 3 lines, and every single line must end in a newline
    stanza: $ => seq(
      $.line, $.newline,
      $.line, $.newline,
      $.line, $.newline
    ),

    // A line is just a series of one or more words
    line: $ => repeat1($.word),

    // A word is any collection of letters or digits
    word: $ => /[a-zA-Z]+|[0-9]+/,

    newline: $ => /\n/
  }
});
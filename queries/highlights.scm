; Use Tree-sitter predicates to map plain words to official editor syntax tokens
((word) @keyword
  (#match? @keyword "^(set|to|add|loop|until|equals|end)$"))

((word) @keyword.function
  (#match? @keyword.function "^(dream|imagine|random|randomly|something)$"))

((word) @number
  (#match? @number "^(zero|one|ten)$"))

((word) @comment
  (#match? @comment "^(the|is|it|quietly|gently|suddenly|always|beautifully|telling|sequence)$"))

((word) @variable
  (#match? @variable "^(x|y|z|count)$"))

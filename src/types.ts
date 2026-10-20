export interface CommentReply {
  id: string
  body: string
  createdAt: number
}

export interface ReviewComment {
  id: string
  repoId: string
  /** Absolute path of the repo root; `filePath` is relative to it. */
  repoPath: string
  filePath: string
  side: 'deletions' | 'additions'
  lineNumber: number
  lineContent: string
  body: string
  status: 'open' | 'resolved'
  createdAt: number
  replies: CommentReply[]
}

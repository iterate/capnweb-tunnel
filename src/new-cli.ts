import * as prompts from '@clack/prompts'
import { createCli } from 'trpc-cli'
import { os } from '@orpc/server'
import { z } from 'zod'

const router = os.router({
    tunnel: os
      .meta({default: true})
      .input(z.object({
            name: z.string(),
            secret: z.string(),
        }))
        .handler(async ({input}) => {
        return { url: 'https://example.com' }
    }),
    deploy: os
      .input(z.object())
      .handler(async ({input}) => {
        return { url: 'https://example.com' }
      })
})

const cli = createCli({router, name: 'capnweb-tunnel', version: '0.0.0'})

cli.run({prompts})

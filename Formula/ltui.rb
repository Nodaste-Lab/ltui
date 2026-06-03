class Ltui < Formula
  desc "Token-efficient Linear CLI for AI coding agents"
  homepage "https://github.com/Nodaste-Lab/ltui"
  url "https://github.com/Nodaste-Lab/ltui.git", branch: "main"
  version "0.1.0"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "ci", "--include=dev", "--no-audit", "--no-fund"
    system "npm", "run", "build"
    system "npm", "prune", "--omit=dev", "--no-audit", "--no-fund"

    libexec.install "bin", "dist", "node_modules", "package.json", "README.md", "SPEC.md"
    bin.install_symlink libexec/"bin/ltui" => "ltui"
  end

  test do
    assert_match "Token-efficient Linear CLI", shell_output("#{bin}/ltui --help")
  end
end
